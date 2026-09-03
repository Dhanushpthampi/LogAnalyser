/**
 * flow-map.js — Draggable & Zoomable Sequence Flow Engine for Logalizer.
 *
 * Features:
 *  - Stores sequence rules with clean schema: { name, pattern, color }.
 *  - Evaluates log records chronologically, generating a new sequence node instance every time a rule matches.
 *  - Interactive Canvas with Zoom & Pan controls.
 *  - Freeform Draggable Nodes with real-time SVG connector updates.
 *  - Interactive log jumping: clicking a node focuses and scrolls to that log line.
 */

import { getComponentColor, repositoryMap } from './repository-map.js';

const STORAGE_KEY = 'logalizer_flow_rules';

export const DEFAULT_RULES = [
  {
    "name": "USB Inserted",
    "pattern": "usb|USB|usbSlot|device_connected|DeviceAttached",
    "color": "#7fdbca"
  },
  {
    "name": "Scanning",
    "pattern": "scan|scanning|MediaScanner",
    "color": "#e6b450"
  },
  {
    "name": "Play",
    "pattern": "play|onPlay|startPlayback|MediaPlayer",
    "color": "#9ba7ff"
  },
  {
    "name": "Pause",
    "pattern": "pause|onPause|stopPlayback",
    "color": "#ff6b6b"
  },
  {
    "name": "USB Ejected",
    "pattern": "eject|unmount|usb_removed|DeviceDetached",
    "color": "#64b5f6"
  }
];

export class FlowMapEngine {
  constructor() {
    this.rules = this.loadRules();
    this.activeTab = 'nodes'; // 'nodes' | 'json'
    this.lastRecords = [];
    this.onRowSelectCallback = null;
    
    // Zoom & Pan state
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;

    // Node occurrences & layout positions
    this.nodeOccurrences = [];
    this.nodePositions = new Map(); // id -> { x, y }
    this.draggingNodeId = null;
    this.dragOffset = { x: 0, y: 0 };
  }

  loadRules() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(r => ({
            name: r.name || 'Unnamed Node',
            pattern: r.pattern || '',
            color: r.color || '#7fdbca'
          }));
        }
      }
    } catch (e) {
      console.warn('Failed to load flow rules, using defaults:', e);
    }
    return DEFAULT_RULES;
  }

  saveRules(rules = this.rules) {
    try {
      this.rules = rules.map(r => ({
        name: r.name || 'Unnamed Node',
        pattern: r.pattern || '',
        color: r.color || '#7fdbca'
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.rules, null, 2));
      return true;
    } catch (e) {
      console.error('Failed to save flow rules:', e);
      return false;
    }
  }

  resetDefaultRules() {
    this.saveRules(DEFAULT_RULES);
    return DEFAULT_RULES;
  }

  setRowSelectCallback(fn) {
    this.onRowSelectCallback = fn;
  }

  setHighlightCallback(fn) {
    this.onHighlightCallback = fn;
  }

  /**
   * Evaluate log records chronologically.
   * Generates a new node occurrence every time a log line matches a rule.
   */
  evaluate(records = []) {
    this.lastRecords = records;
    const occurrences = [];

    // Compile active rules into regular expressions
    const compiledRules = this.rules.map((rule, idx) => {
      let rx = null;
      if (rule.pattern && rule.pattern.trim()) {
        try {
          rx = new RegExp(rule.pattern.trim(), 'i');
        } catch (e) {
          rx = null;
        }
      }
      return { rule, rx, index: idx };
    });

    let seqCounter = 1;

    // Iterate through log records line by line
    for (const rec of records) {
      const textToMatch = `${rec.component || ''} ${rec.message || ''} ${rec.raw || ''}`;
      for (const item of compiledRules) {
        if (item.rx && item.rx.test(textToMatch)) {
          // Resolve color from repository map if it exists, otherwise use rule color or default
          let repoColor = getComponentColor(rec.component);
          if (!repoColor && repositoryMap?.size > 0) {
            for (const [key, val] of repositoryMap.entries()) {
              if (val && (rec.message?.includes(key) || rec.raw?.includes(key))) {
                repoColor = val;
                break;
              }
            }
          }
          const nodeColor = repoColor || item.rule.color || '#7fdbca';

          occurrences.push({
            id: `node_occ_${seqCounter}_${rec.line}`,
            seqIndex: seqCounter++,
            name: item.rule.name || `Node ${item.index + 1}`,
            pattern: item.rule.pattern,
            color: nodeColor,
            record: rec,
            line: rec.line,
            timestamp: rec.timestamp || '',
            isHit: true
          });
          break; // Match first rule per log line
        }
      }
    }

    // Include all rules that were never hit so they appear as pending/grayed out
    const hitRuleNames = new Set(occurrences.map(o => o.name));
    this.rules.forEach((rule, idx) => {
      if (!hitRuleNames.has(rule.name)) {
        occurrences.push({
          id: `unhit_node_${idx}_${rule.name}`,
          seqIndex: seqCounter++,
          name: rule.name || `Node ${idx + 1}`,
          pattern: rule.pattern,
          color: rule.color || '#7fdbca',
          record: null,
          line: null,
          timestamp: '',
          isHit: false
        });
      }
    });

    this.nodeOccurrences = occurrences;
    this.autoLayoutNodes();
    return occurrences;
  }

  /**
   * Automatically calculate initial vertical layout coordinates for nodes.
   */
  autoLayoutNodes() {
    const startX = 60;
    const unhitStartX = 280;
    const startY = 30;
    const verticalGap = 80;

    let hitCounter = 0;
    let unhitCounter = 0;

    this.nodeOccurrences.forEach((node) => {
      if (!this.nodePositions.has(node.id)) {
        if (node.isHit) {
          this.nodePositions.set(node.id, {
            x: startX,
            y: startY + hitCounter * verticalGap
          });
          hitCounter++;
        } else {
          this.nodePositions.set(node.id, {
            x: unhitStartX,
            y: startY + unhitCounter * verticalGap
          });
          unhitCounter++;
        }
      }
    });
  }

  resetNodePositions() {
    this.nodePositions.clear();
    this.autoLayoutNodes();
  }

  /**
   * Renders the interactive Zoom & Pan Canvas with Draggable Nodes.
   */
  renderNodeView(container) {
    if (!container) return;

    container.replaceChildren();

    const occurrences = this.nodeOccurrences;
    const hitNodes = occurrences.filter(n => n.isHit).length;

    // Viewport Container
    const viewport = document.createElement('div');
    viewport.className = 'flow-viewport';

    // KPI Summary Header
    const summaryBar = document.createElement('div');
    summaryBar.className = 'flow-summary-bar';
    summaryBar.innerHTML = `
      <div class="flow-summary-item">
        <span class="flow-summary-val">${hitNodes}</span>
        <span class="flow-summary-lbl">Occurrences Hit</span>
      </div>
      <div class="flow-summary-item">
        <span class="flow-summary-val">${occurrences.length}</span>
        <span class="flow-summary-lbl">Total Flow Nodes</span>
      </div>
    `;
    viewport.appendChild(summaryBar);

    // Canvas Container (Pannable & Zoomable)
    const canvas = document.createElement('div');
    canvas.className = 'flow-canvas';
    canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;

    // SVG Connector overlay layer
    const svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgLayer.setAttribute('class', 'flow-svg-layer');

    // SVG Marker definitions for arrowheads
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <marker id="flow-arrow-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--cyan)" />
      </marker>
      <marker id="flow-arrow-head-muted" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--line)" />
      </marker>
    `;
    svgLayer.appendChild(defs);
    canvas.appendChild(svgLayer);

    // Nodes Container
    const nodesLayer = document.createElement('div');
    nodesLayer.className = 'flow-nodes-layer';

    const nodeElementsMap = new Map();

    occurrences.forEach((node) => {
      const pos = this.nodePositions.get(node.id) || { x: 50, y: 50 };

      const card = document.createElement('div');
      card.className = `flow-node-card ${node.isHit ? 'is-hit' : 'is-unhit'}`;
      card.style.left = `${pos.x}px`;
      card.style.top = `${pos.y}px`;
      card.style.setProperty('--node-theme-color', node.color || '#7fdbca');
      card.dataset.nodeId = node.id;

      // Card Content: Node Name
      card.innerHTML = `
        <div class="flow-node-drag-handle">
          <span class="flow-node-name">${node.name}</span>
          ${!node.isHit ? '<span class="flow-node-pending-tag">Pending</span>' : ''}
        </div>
      `;

      // Click to highlight and jump to exact triggering log line
      if (node.isHit && node.record) {
        card.addEventListener('click', (e) => {
          if (e.defaultPrevented) return;
          // Highlight the specific line that triggered this node
          if (typeof this.onHighlightCallback === 'function') {
            this.onHighlightCallback(node.record);
          } else if (typeof this.onRowSelectCallback === 'function') {
            this.onRowSelectCallback(node.record);
          }
        });
      }

      // Drag Handlers for individual node card
      card.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // Only left click
        e.stopPropagation();
        card.setPointerCapture(e.pointerId);

        this.draggingNodeId = node.id;
        const rect = card.getBoundingClientRect();
        this.dragOffset = {
          x: (e.clientX - rect.left) / this.zoom,
          y: (e.clientY - rect.top) / this.zoom
        };
        card.classList.add('is-dragging');
      });

      card.addEventListener('pointermove', (e) => {
        if (this.draggingNodeId !== node.id) return;
        e.stopPropagation();

        const canvasRect = canvas.getBoundingClientRect();
        const newX = (e.clientX - canvasRect.left) / this.zoom - this.dragOffset.x;
        const newY = (e.clientY - canvasRect.top) / this.zoom - this.dragOffset.y;

        pos.x = Math.max(10, newX);
        pos.y = Math.max(10, newY);
        this.nodePositions.set(node.id, pos);

        card.style.left = `${pos.x}px`;
        card.style.top = `${pos.y}px`;

        this.updateSvgConnectors(svgLayer, nodeElementsMap);
      });

      const onPointerUp = (e) => {
        if (this.draggingNodeId === node.id) {
          this.draggingNodeId = null;
          card.classList.remove('is-dragging');
          if (card.hasPointerCapture(e.pointerId)) {
            card.releasePointerCapture(e.pointerId);
          }
        }
      };

      card.addEventListener('pointerup', onPointerUp);
      card.addEventListener('pointercancel', onPointerUp);

      nodesLayer.appendChild(card);
      nodeElementsMap.set(node.id, { element: card, data: node });
    });

    canvas.appendChild(nodesLayer);
    viewport.appendChild(canvas);

    // Allow native-like scrolling using wheel
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Adjust pan based on scroll delta
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }, { passive: false });

    // Canvas Background Pan only — no wheel zoom (use buttons instead)
    viewport.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.flow-node-card') || e.button !== 0) return;
      this.isPanning = true;
      this.panStartX = e.clientX - this.panX;
      this.panStartY = e.clientY - this.panY;
      viewport.style.cursor = 'grabbing';
      viewport.setPointerCapture(e.pointerId);
    });

    viewport.addEventListener('pointermove', (e) => {
      if (!this.isPanning) return;
      this.panX = e.clientX - this.panStartX;
      this.panY = e.clientY - this.panStartY;
      canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    });

    const endPan = (e) => {
      if (this.isPanning) {
        this.isPanning = false;
        viewport.style.cursor = 'grab';
        if (viewport.hasPointerCapture(e.pointerId)) {
          viewport.releasePointerCapture(e.pointerId);
        }
      }
    };

    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);

    container.appendChild(viewport);

    // Initial SVG connector draw after layout render
    requestAnimationFrame(() => {
      this.updateSvgConnectors(svgLayer, nodeElementsMap);
    });
  }

  /**
   * Draw connecting curves/arrows between sequential nodes in the SVG overlay layer.
   */
  updateSvgConnectors(svgLayer, nodeElementsMap) {
    if (!svgLayer) return;

    // Clear existing paths except <defs>
    const defs = svgLayer.querySelector('defs');
    svgLayer.replaceChildren(defs);

    const occurrences = this.nodeOccurrences;
    for (let i = 0; i < occurrences.length - 1; i++) {
      const currNode = occurrences[i];
      const nextNode = occurrences[i + 1];

      // Do not draw connectors to or from untriggered nodes
      if (!currNode.isHit || !nextNode.isHit) continue;

      const currItem = nodeElementsMap.get(currNode.id);
      const nextItem = nodeElementsMap.get(nextNode.id);

      if (!currItem || !nextItem) continue;

      const currEl = currItem.element;
      const nextEl = nextItem.element;

      const currPos = this.nodePositions.get(currNode.id);
      const nextPos = this.nodePositions.get(nextNode.id);

      if (!currPos || !nextPos) continue;

      const currWidth = currEl.offsetWidth || 180;
      const currHeight = currEl.offsetHeight || 38;
      const nextWidth = nextEl.offsetWidth || 180;

      // Calculate start and end anchor points
      const startX = currPos.x + currWidth / 2;
      const startY = currPos.y + currHeight;
      const endX = nextPos.x + nextWidth / 2;
      const endY = nextPos.y;

      const controlY1 = startY + Math.max(20, (endY - startY) / 2);
      const controlY2 = endY - Math.max(20, (endY - startY) / 2);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = `M ${startX} ${startY} C ${startX} ${controlY1}, ${endX} ${controlY2}, ${endX} ${endY}`;
      path.setAttribute('d', d);

      const isActive = currNode.isHit && nextNode.isHit;
      path.setAttribute('class', `flow-connector-path ${isActive ? 'is-active' : ''}`);
      path.setAttribute('marker-end', isActive ? 'url(#flow-arrow-head)' : 'url(#flow-arrow-head-muted)');

      svgLayer.appendChild(path);
    }
  }
}
