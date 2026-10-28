(function () {
  "use strict";

  const Core = window.MindmapCore;
  const LIBRARY_KEY = "mindmap-studio.library.v1";
  const CURRENT_KEY = "mindmap-studio.current.v1";
  const HISTORY_LIMIT = 60;
  const SVG_NS = "http://www.w3.org/2000/svg";

  let library = [];
  let map;
  let selectedNodeId = null;
  let activeTab = "node";
  let undoStack = [];
  let redoStack = [];
  let saveTimer = null;
  let toastTimer = null;
  let flowOpen = false;
  let mapWidth = 0;
  let mapHeight = 0;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let panning = null;
  let collapsedIds = new Set();

  const el = (id) => document.getElementById(id);
  const svg = el("mindmapSvg");
  const transform = el("mapTransform");
  const canvasWrap = el("canvasWrap");

  function safeLocalStorageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function loadLibrary() {
    const saved = safeLocalStorageGet(LIBRARY_KEY);
    if (!saved) return [];
    try {
      const list = JSON.parse(saved);
      return Array.isArray(list) ? list.map((item) => {
        try { return Core.normalizeMap(item); } catch (_) { return null; }
      }).filter(Boolean) : [];
    } catch (_) { return []; }
  }

  function persistLibrary() {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
      localStorage.setItem(CURRENT_KEY, map.id);
      return true;
    } catch (error) {
      setStatus("Browser storage unavailable · export a backup");
      showToast(`Could not save to browser storage: ${error.message}`);
      return false;
    }
  }

  function setStatus(message) {
    el("saveStatus").textContent = message;
  }

  function saveCurrentMap(showMessage) {
    if (!map) return;
    map.updatedAt = new Date().toISOString();
    library = library.filter((item) => item.id !== map.id);
    library.unshift(Core.clone(map));
    const saved = persistLibrary();
    if (saved && showMessage) {
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setStatus(`Saved locally · ${time}`);
      showToast("Map saved in this browser.");
    }
    renderLibraryCount();
  }

  function scheduleSave() {
    setStatus("Saving locally…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveCurrentMap(false), 500);
  }

  function renderLibraryCount() {
    const count = library.length;
    el("libraryBtn").title = `${count} saved map${count === 1 ? "" : "s"} in this browser`;
  }

  function showToast(message) {
    const toast = el("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function pushUndo() {
    if (!map) return;
    undoStack.push(Core.clone(map));
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    el("undoBtn").disabled = undoStack.length === 0;
    el("redoBtn").disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(Core.clone(map));
    map = undoStack.pop();
    selectedNodeId = map.nodes.find((node) => node.parentId === null)?.id || null;
    initializeCollapsed();
    saveCurrentMap(false);
    renderAll();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(Core.clone(map));
    map = redoStack.pop();
    selectedNodeId = map.nodes.find((node) => node.parentId === null)?.id || null;
    initializeCollapsed();
    saveCurrentMap(false);
    renderAll();
  }

  function findNode(id) {
    return map.nodes.find((node) => node.id === id) || null;
  }

  function getRoot() {
    return map.nodes.find((node) => node.parentId === null) || map.nodes[0];
  }

  function nodeChildren(parentId) {
    return map.nodes.filter((node) => node.parentId === parentId);
  }

  function descendantsOf(nodeId) {
    const result = new Set();
    const queue = [nodeId];
    while (queue.length) {
      const current = queue.pop();
      for (const child of nodeChildren(current)) {
        if (!result.has(child.id)) { result.add(child.id); queue.push(child.id); }
      }
    }
    return result;
  }

  function initializeCollapsed() {
    collapsedIds = new Set(map.nodes.filter((node) => node.parentId !== null && nodeChildren(node.id).length > 0).map((node) => node.id));
  }

  function expandAncestors(nodeId) {
    let node = findNode(nodeId);
    while (node && node.parentId) {
      collapsedIds.delete(node.parentId);
      node = findNode(node.parentId);
    }
  }

  function toggleCollapsed(node) {
    const collapsing = !collapsedIds.has(node.id);
    if (collapsing && selectedNodeId && descendantsOf(node.id).has(selectedNodeId)) selectedNodeId = node.id;
    if (collapsing) collapsedIds.add(node.id); else collapsedIds.delete(node.id);
    renderMap();
    if (activeTab === "node") renderNodeEditor();
    fitCanvas();
  }

  function wrapWords(value, maxChars, maxLines) {
    const words = String(value || "Untitled node").split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      if (line && `${line} ${word}`.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      const clipped = lines.slice(0, maxLines);
      clipped[maxLines - 1] = clipped[maxLines - 1].replace(/[.,;:]?$/, "…");
      return clipped;
    }
    return lines;
  }

  function svgEl(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    return node;
  }

  function renderMap() {
    if (!map) return;
    transform.replaceChildren();
    const root = getRoot();
    if (!root) return;

    const children = new Map();
    for (const node of map.nodes) {
      if (!children.has(node.parentId || "")) children.set(node.parentId || "", []);
      children.get(node.parentId || "").push(node);
    }
    const width = 226;
    const xStep = 296;
    const verticalGap = 17;
    const positions = new Map();
    const visibleKids = (node) => collapsedIds.has(node.id) ? [] : (children.get(node.id) || []);

    function measure(node, depth) {
      const lines = wrapWords(node.title, depth === 0 ? 26 : 29, 3);
      const boxHeight = Math.max(depth === 0 ? 76 : 67, 34 + lines.length * 17 + 12);
      const kids = visibleKids(node);
      const kidHeights = kids.map((child) => measure(child, depth + 1));
      const childBlock = kidHeights.length ? kidHeights.reduce((sum, value) => sum + value, 0) + verticalGap * (kidHeights.length - 1) : 0;
      const block = Math.max(boxHeight, childBlock);
      positions.set(node.id, { node, depth, width, height: boxHeight, lines, block, childCount: (children.get(node.id) || []).length, collapsed: collapsedIds.has(node.id) });
      return block;
    }
    const totalHeight = measure(root, 0);
    function place(node, depth, centerY) {
      const item = positions.get(node.id);
      item.x = 58 + depth * xStep;
      item.y = centerY;
      const kids = visibleKids(node);
      if (!kids.length) return;
      const block = kids.reduce((sum, child) => sum + positions.get(child.id).block, 0) + verticalGap * (kids.length - 1);
      let cursor = centerY - block / 2;
      for (const child of kids) {
        const childItem = positions.get(child.id);
        const childCenter = cursor + childItem.block / 2;
        place(child, depth + 1, childCenter);
        cursor += childItem.block + verticalGap;
      }
    }
    place(root, 0, totalHeight / 2 + 35);
    const depthMax = Math.max(...[...positions.values()].map((item) => item.depth));
    mapWidth = 58 + depthMax * xStep + width + 80;
    mapHeight = Math.max(440, totalHeight + 90);

    const edgeGroup = svgEl("g", { "aria-hidden": "true" });
    for (const item of positions.values()) {
      if (!item.node.parentId) continue;
      const parent = positions.get(item.node.parentId);
      if (!parent) continue;
      const startX = parent.x + width;
      const endX = item.x;
      const midX = (startX + endX) / 2;
      edgeGroup.appendChild(svgEl("path", {
        class: "edge",
        d: `M ${startX} ${parent.y} C ${midX} ${parent.y}, ${midX} ${item.y}, ${endX} ${item.y}`
      }));
    }
    transform.appendChild(edgeGroup);

    for (const item of positions.values()) {
      const node = item.node;
      const group = svgEl("g", {
        class: `map-node${node.parentId === null ? " root" : ""}${node.id === selectedNodeId ? " selected" : ""}`,
        transform: `translate(${item.x} ${item.y - item.height / 2})`,
        tabindex: "0",
        role: "button",
        "aria-label": `${node.title}, ${node.kind || "topic"}`
      });
      group.appendChild(svgEl("rect", { x: 0, y: 0, width, height: item.height, rx: 13 }));
      const kind = svgEl("text", { x: 13, y: 17, class: "node-kind" });
      kind.textContent = node.kind || "topic";
      group.appendChild(kind);
      const title = svgEl("text", { x: 13, y: 37, class: "node-title" });
      item.lines.forEach((line, index) => {
        const tspan = svgEl("tspan", { x: 13, dy: index === 0 ? 0 : 17 });
        tspan.textContent = line;
        title.appendChild(tspan);
      });
      group.appendChild(title);
      if (item.childCount) {
        const toggle = svgEl("g", {
          class: "collapse-control",
          transform: `translate(${width - 10} ${item.height / 2})`,
          tabindex: "0",
          role: "button",
          "aria-label": item.collapsed ? `Expand ${item.childCount} child branches` : "Collapse child branches"
        });
        toggle.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 9 }));
        const sign = svgEl("text", { x: 0, y: 4, "text-anchor": "middle" });
        sign.textContent = item.collapsed ? "+" : "−";
        toggle.appendChild(sign);
        toggle.addEventListener("click", (event) => { event.stopPropagation(); toggleCollapsed(node); });
        toggle.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleCollapsed(node); }
        });
        group.appendChild(toggle);
      }
      if (item.childCount) {
        const sub = svgEl("text", { x: width - 12, y: item.height - 9, "text-anchor": "end", class: "node-kind" });
        sub.textContent = item.collapsed ? `${item.childCount} hidden` : `${item.childCount} ${item.childCount === 1 ? "branch" : "branches"}`;
        group.appendChild(sub);
      }
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectNode(node.id);
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node.id); }
      });
      transform.appendChild(group);
    }

    const rect = canvasWrap.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    applyTransform();
    el("nodeCount").textContent = `${positions.size} shown · ${map.nodes.length} total nodes`;
    if (!selectedNodeId || !findNode(selectedNodeId)) selectedNodeId = root.id;
    updateSelectionLabel();
  }

  function applyTransform() {
    transform.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`);
    el("zoomReadout").textContent = `${Math.round(zoom * 100)}%`;
  }

  function fitCanvas() {
    if (!mapWidth || !mapHeight) return;
    const rect = canvasWrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    zoom = Math.max(.18, Math.min(1.25, (rect.width - 60) / mapWidth, (rect.height - 60) / mapHeight));
    panX = (rect.width - mapWidth * zoom) / 2;
    panY = (rect.height - mapHeight * zoom) / 2;
    applyTransform();
  }

  function updateSelectionLabel() {
    const node = findNode(selectedNodeId);
    el("selectionLabel").textContent = node ? `${node.title} · ${node.kind || "topic"}` : "Select a node to edit its content and assignments";
  }

  function selectNode(id) {
    selectedNodeId = id;
    expandAncestors(id);
    if (flowOpen) closeFlow();
    renderMap();
    if (activeTab === "node") renderNodeEditor();
    updateSelectionLabel();
  }

  function createField(label, control, helper) {
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    const name = document.createElement("span");
    name.textContent = label;
    wrapper.append(name, control);
    if (helper) {
      const small = document.createElement("small");
      small.textContent = helper;
      wrapper.appendChild(small);
    }
    return wrapper;
  }

  function recordEdit(mutator, options) {
    pushUndo();
    mutator();
    const settings = options || {};
    if (settings.renderMap !== false) renderMap();
    if (settings.renderInspector) renderNodeEditor();
    if (flowOpen) renderFlow();
    updateHeader();
    scheduleSave();
  }

  function renderNodeEditor() {
    const container = el("nodeEditor");
    container.replaceChildren();
    const node = findNode(selectedNodeId) || getRoot();
    if (!node) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "This map has no nodes yet. Use New to create a starting point.";
      container.appendChild(empty);
      return;
    }

    const title = document.createElement("input");
    title.value = node.title;
    title.maxLength = 500;
    title.setAttribute("aria-label", "Node title");
    title.addEventListener("input", () => {
      recordEdit(() => {
        node.title = title.value;
        if (node.parentId === null) map.title = title.value.trim() || "Untitled mindmap";
      }, { renderMap: true });
      updateSelectionLabel();
    });
    container.appendChild(createField("Title", title));

    const notes = document.createElement("textarea");
    notes.value = node.notes || "";
    notes.maxLength = 12000;
    notes.placeholder = "Context, constraints, or evidence…";
    notes.addEventListener("input", () => {
      recordEdit(() => { node.notes = notes.value; }, { renderMap: false });
    });
    container.appendChild(createField("Notes", notes, "Use this for short explanations, evidence, or constraints."));

    const kind = document.createElement("select");
    for (const option of ["topic", "workflow", "task", "gate", "agent", "constraint"]) {
      const opt = document.createElement("option");
      opt.value = option; opt.textContent = option[0].toUpperCase() + option.slice(1); kind.appendChild(opt);
    }
    kind.value = node.kind || "topic";
    kind.addEventListener("change", () => recordEdit(() => { node.kind = kind.value; }, { renderMap: true }));
    container.appendChild(createField("Node type", kind));

    if (node.parentId === null) {
      const rootNote = document.createElement("div");
      rootNote.className = "empty-state";
      rootNote.style.margin = "4px 0 14px";
      rootNote.textContent = "This is the map root. Add a child to branch out.";
      container.appendChild(rootNote);
    } else {
      const excluded = descendantsOf(node.id);
      excluded.add(node.id);
      const parent = document.createElement("select");
      const rootOption = document.createElement("option");
      rootOption.value = getRoot().id; rootOption.textContent = `Map root · ${getRoot().title}`; parent.appendChild(rootOption);
      for (const candidate of map.nodes) {
        if (candidate.id === getRoot().id || excluded.has(candidate.id)) continue;
        const option = document.createElement("option");
        option.value = candidate.id;
        option.textContent = candidate.title;
        parent.appendChild(option);
      }
      parent.value = node.parentId;
      parent.addEventListener("change", () => {
        recordEdit(() => { node.parentId = parent.value; }, { renderInspector: true });
        collapsedIds.delete(parent.value);
        expandAncestors(node.id);
        renderMap(); fitCanvas();
      });
      container.appendChild(createField("Parent node", parent, "Changing the parent moves this node and its subtree."));
    }

    const workflowInput = document.createElement("input");
    workflowInput.value = node.workflowId || "";
    workflowInput.placeholder = "e.g. grunt-team";
    workflowInput.maxLength = 80;
    workflowInput.addEventListener("input", () => recordEdit(() => { node.workflowId = workflowInput.value.trim(); }, { renderMap: false }));
    container.appendChild(createField("Workflow ID", workflowInput, "Set this to group the node in Agent Flow."));

    const orderInput = document.createElement("input");
    orderInput.type = "number"; orderInput.min = "1"; orderInput.step = "1"; orderInput.value = node.flowOrder || "";
    orderInput.placeholder = "—";
    orderInput.addEventListener("input", () => recordEdit(() => {
      const number = Number(orderInput.value);
      node.flowOrder = Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
    }, { renderMap: false }));
    container.appendChild(createField("Flow step", orderInput, "Nodes with a workflow ID and step number appear in Agent Flow."));

    const fieldset = document.createElement("fieldset");
    fieldset.className = "fieldset";
    const legend = document.createElement("legend"); legend.textContent = "Assigned agents"; fieldset.appendChild(legend);
    const list = document.createElement("div"); list.className = "assignment-list";
    if (!map.agents.length) {
      const msg = document.createElement("p"); msg.className = "helper"; msg.textContent = "No agents yet. Add one in the Agents tab."; list.appendChild(msg);
    }
    for (const agent of map.agents) {
      const label = document.createElement("label"); label.className = "assignment-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = node.agentIds.includes(agent.id);
      checkbox.addEventListener("change", () => recordEdit(() => {
        node.agentIds = checkbox.checked ? [...new Set([...node.agentIds, agent.id])] : node.agentIds.filter((id) => id !== agent.id);
      }, { renderMap: false }));
      const details = document.createElement("span");
      const strong = document.createElement("strong"); strong.textContent = agent.name || agent.id;
      const small = document.createElement("small"); small.textContent = agent.summary || "Summary not set";
      details.append(strong, small); label.append(checkbox, details); list.appendChild(label);
    }
    fieldset.appendChild(list); container.appendChild(fieldset);

    const actions = document.createElement("div"); actions.className = "edit-actions";
    const addSibling = document.createElement("button"); addSibling.type = "button"; addSibling.className = "btn"; addSibling.textContent = "＋ Sibling";
    addSibling.addEventListener("click", addSiblingNode);
    const moveUp = document.createElement("button"); moveUp.type = "button"; moveUp.className = "btn"; moveUp.textContent = "↑ Move up";
    moveUp.addEventListener("click", () => moveSibling(-1));
    const moveDown = document.createElement("button"); moveDown.type = "button"; moveDown.className = "btn"; moveDown.textContent = "↓ Move down";
    moveDown.addEventListener("click", () => moveSibling(1));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn danger"; remove.textContent = "Delete subtree";
    remove.disabled = node.parentId === null;
    remove.addEventListener("click", deleteSelectedNode);
    actions.append(addSibling, moveUp, moveDown, remove); container.appendChild(actions);
  }

  function addChildNode() {
    const parent = findNode(selectedNodeId) || getRoot();
    if (map.nodes.length >= Core.MAX_NODES) { showToast("This map reached the node limit."); return; }
    pushUndo();
    const node = { id: Core.uid("node"), parentId: parent.id, title: "New idea", notes: "", kind: "topic", workflowId: parent.workflowId || "", flowOrder: null, agentIds: [] };
    collapsedIds.delete(parent.id);
    expandAncestors(parent.id);
    const parentIndex = map.nodes.findIndex((item) => item.id === parent.id);
    map.nodes.splice(parentIndex + 1, 0, node);
    selectedNodeId = node.id;
    renderAll(); scheduleSave();
    setTimeout(() => { const input = el("nodeEditor").querySelector("input"); if (input) { input.focus(); input.select(); } }, 0);
  }

  function addSiblingNode() {
    const selected = findNode(selectedNodeId) || getRoot();
    const parentId = selected.parentId || selected.id;
    if (map.nodes.length >= Core.MAX_NODES) { showToast("This map reached the node limit."); return; }
    pushUndo();
    const node = { id: Core.uid("node"), parentId, title: "New idea", notes: "", kind: "topic", workflowId: selected.workflowId || "", flowOrder: null, agentIds: [] };
    const index = map.nodes.findIndex((item) => item.id === selected.id);
    map.nodes.splice(index + 1, 0, node);
    selectedNodeId = node.id;
    renderAll(); scheduleSave();
  }

  function moveSibling(direction) {
    const node = findNode(selectedNodeId);
    if (!node || node.parentId === null) return;
    const siblings = map.nodes.filter((item) => item.parentId === node.parentId);
    const position = siblings.findIndex((item) => item.id === node.id);
    const target = position + direction;
    if (target < 0 || target >= siblings.length) return;
    pushUndo();
    const other = siblings[target];
    const indexA = map.nodes.findIndex((item) => item.id === node.id);
    const indexB = map.nodes.findIndex((item) => item.id === other.id);
    [map.nodes[indexA], map.nodes[indexB]] = [map.nodes[indexB], map.nodes[indexA]];
    renderAll(); scheduleSave();
  }

  function deleteSelectedNode() {
    const node = findNode(selectedNodeId);
    if (!node || node.parentId === null) return;
    if (!window.confirm(`Delete “${node.title}” and all of its child nodes?`)) return;
    pushUndo();
    const removeIds = descendantsOf(node.id); removeIds.add(node.id);
    map.nodes = map.nodes.filter((item) => !removeIds.has(item.id));
    selectedNodeId = node.parentId;
    renderAll(); scheduleSave();
  }

  function renderAgents() {
    const list = el("agentList");
    list.replaceChildren();
    for (const agent of map.agents) {
      const card = document.createElement("article"); card.className = "agent-card";
      const head = document.createElement("div"); head.className = "agent-card-head";
      const label = document.createElement("strong"); label.textContent = `${agent.id} · Agent`;
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn danger"; remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (!window.confirm(`Remove ${agent.name || agent.id} and clear its assignments?`)) return;
        pushUndo(); map.agents = map.agents.filter((item) => item.id !== agent.id);
        for (const node of map.nodes) node.agentIds = node.agentIds.filter((id) => id !== agent.id);
        renderAll(); scheduleSave();
      });
      head.append(label, remove); card.appendChild(head);
      addAgentInput(card, agent, "Name", "name", "text");
      addAgentInput(card, agent, "Model", "model", "text");
      addAgentInput(card, agent, "Role", "role", "textarea");
      const summaryField = addAgentInput(card, agent, "3–4 word summary", "summary", "text");
      const count = document.createElement("div"); count.className = "summary-count";
      function updateCount() {
        const words = Core.countWords(agent.summary);
        count.textContent = `${words} word${words === 1 ? "" : "s"}${words >= 3 && words <= 4 ? " · looks good" : " · aim for 3–4"}`;
        count.classList.toggle("invalid", words < 3 || words > 4);
      }
      updateCount();
      summaryField.after(count);
      list.appendChild(card);
    }
    if (!map.agents.length) {
      const empty = document.createElement("div"); empty.className = "empty-state";
      empty.textContent = "No agents yet. Add an agent to assign owners and build an Agent Flow view.";
      list.appendChild(empty);
    }
  }

  function addAgentInput(card, agent, labelText, key, type) {
    const field = document.createElement("label"); field.className = "field";
    const label = document.createElement("span"); label.textContent = labelText; field.appendChild(label);
    const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
    if (type !== "textarea") input.type = "text";
    input.value = agent[key] || "";
    input.maxLength = key === "summary" ? 120 : 1200;
    input.addEventListener("input", () => {
      pushUndo(); agent[key] = input.value;
      if (key === "name") renderMap();
      if (key === "summary" || key === "name" || key === "role" || key === "model") {
        if (flowOpen) renderFlow();
      }
      scheduleSave();
      if (key === "summary") {
        const cardCount = card.querySelector(".summary-count");
        if (cardCount) {
          const words = Core.countWords(agent.summary);
          cardCount.textContent = `${words} word${words === 1 ? "" : "s"}${words >= 3 && words <= 4 ? " · looks good" : " · aim for 3–4"}`;
          cardCount.classList.toggle("invalid", words < 3 || words > 4);
        }
      }
    });
    field.appendChild(input); card.appendChild(field);
    return field;
  }

  function addAgent() {
    if (map.agents.length >= Core.MAX_AGENTS) { showToast("This map reached the agent limit."); return; }
    pushUndo();
    const id = Core.uid("agent");
    map.agents.push({ id, name: "New agent", model: "", role: "", summary: "Assigned work not specified" });
    renderAll(); scheduleSave();
    setActiveTab("agents");
    setTimeout(() => { const input = el("agentList").querySelector("input"); if (input) { input.focus(); input.select(); } }, 0);
  }

  function renderSources() {
    const list = el("sourceList"); list.replaceChildren();
    for (const source of map.sources) {
      const card = document.createElement("article"); card.className = "source-card";
      const title = document.createElement("strong"); title.textContent = source.title;
      const note = document.createElement("p"); note.textContent = source.note || "";
      card.append(title);
      if (source.note) card.appendChild(note);
      if (source.path) {
        const path = document.createElement("code"); path.className = "source-path"; path.textContent = source.path; card.appendChild(path);
        const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn"; copy.textContent = "Copy link";
        copy.addEventListener("click", () => copyText(source.path, "Source link copied.")); card.appendChild(copy);
      }
      list.appendChild(card);
    }
    if (!map.sources.length) {
      const empty = document.createElement("div"); empty.className = "empty-state";
      empty.textContent = "No source references in this map yet. Add them in the native JSON or AI build-up prompt.";
      list.appendChild(empty);
    }
  }

  function setActiveTab(tab) {
    activeTab = tab;
    for (const [name, id] of [["node", "tabNode"], ["agents", "tabAgents"], ["sources", "tabSources"]]) {
      el(id).setAttribute("aria-selected", String(name === tab));
    }
    el("nodePanel").hidden = tab !== "node";
    el("agentsPanel").hidden = tab !== "agents";
    el("sourcesPanel").hidden = tab !== "sources";
    if (tab === "node") renderNodeEditor();
    if (tab === "agents") renderAgents();
    if (tab === "sources") renderSources();
  }

  function updateHeader() {
    el("mapTitleDisplay").textContent = map.title || "Untitled mindmap";
    el("themeSelect").value = map.theme || "paper";
    document.documentElement.setAttribute("data-theme", map.theme || "paper");
    updateSelectionLabel();
  }

  function renderAll() {
    updateHeader();
    renderMap();
    if (activeTab === "node") renderNodeEditor();
    if (activeTab === "agents") renderAgents();
    if (activeTab === "sources") renderSources();
    if (flowOpen) renderFlow();
    updateHistoryButtons();
    renderLibraryCount();
  }

  function workflowNodes() {
    return map.nodes.filter((node) => node.workflowId && node.flowOrder !== null);
  }

  function renderFlowFilter() {
    const select = el("flowFilter");
    const old = select.value;
    select.replaceChildren();
    const all = document.createElement("option"); all.value = "all"; all.textContent = "All workflows"; select.appendChild(all);
    const ids = [...new Set(workflowNodes().map((node) => node.workflowId))];
    for (const id of ids) {
      const option = document.createElement("option"); option.value = id;
      const workflow = map.nodes.find((node) => node.kind === "workflow" && node.workflowId === id);
      option.textContent = workflow ? workflow.title : id;
      select.appendChild(option);
    }
    select.value = ids.includes(old) || old === "all" ? old : "all";
  }

  function renderFlow() {
    const content = el("flowContent"); content.replaceChildren();
    renderFlowFilter();
    const filter = el("flowFilter").value || "all";
    const groups = new Map();
    const flowTasks = workflowNodes().filter((node) => filter === "all" || node.workflowId === filter);
    for (const task of flowTasks) {
      if (!groups.has(task.workflowId)) groups.set(task.workflowId, []);
      groups.get(task.workflowId).push(task);
    }
    if (!groups.size) {
      const empty = document.createElement("div"); empty.className = "empty-state";
      empty.textContent = "No nodes have both a workflow ID and a step number. Select a task node, then set those fields in the Node tab.";
      content.appendChild(empty); return;
    }
    for (const [workflowId, tasks] of groups) {
      tasks.sort((a, b) => a.flowOrder - b.flowOrder || map.nodes.indexOf(a) - map.nodes.indexOf(b));
      const group = document.createElement("section"); group.className = "flow-group";
      const heading = document.createElement("h3"); heading.className = "flow-group-title";
      const workflow = map.nodes.find((node) => node.kind === "workflow" && node.workflowId === workflowId);
      const title = document.createElement("strong"); title.textContent = workflow ? workflow.title : workflowId;
      const status = document.createElement("span"); status.textContent = workflow?.notes || "Documented workflow";
      heading.append(title, status); group.appendChild(heading);
      const steps = new Map();
      for (const task of tasks) {
        if (!steps.has(task.flowOrder)) steps.set(task.flowOrder, []);
        steps.get(task.flowOrder).push(task);
      }
      const row = document.createElement("div"); row.className = "flow-steps";
      for (const [number, stepTasks] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
        const step = document.createElement("div"); step.className = "flow-step";
        const label = document.createElement("div"); label.className = "flow-step-label"; label.textContent = `Step ${number}`; step.appendChild(label);
        for (const task of stepTasks) {
          const taskButton = document.createElement("button"); taskButton.type = "button"; taskButton.className = "flow-task";
          taskButton.addEventListener("click", () => { selectNode(task.id); setActiveTab("node"); fitCanvas(); });
          const name = document.createElement("strong"); name.textContent = task.title; taskButton.appendChild(name);
          if (task.notes) { const note = document.createElement("p"); note.textContent = task.notes; taskButton.appendChild(note); }
          if (task.agentIds.length) {
            for (const agentId of task.agentIds) {
              const agent = map.agents.find((item) => item.id === agentId) || { id: agentId, name: agentId, summary: "Assigned work not specified", role: "", model: "" };
              const card = document.createElement("div"); card.className = "flow-agent";
              const agentName = document.createElement("strong"); agentName.textContent = agent.name || agent.id;
              const detail = document.createElement("small"); detail.textContent = [agent.summary || "Assigned work not specified", agent.role, agent.model].filter(Boolean).join(" · ");
              card.append(agentName, detail); taskButton.appendChild(card);
            }
          } else {
            const unassigned = document.createElement("div"); unassigned.className = "flow-unassigned";
            unassigned.textContent = "No fixed agent named in the source for this step.";
            taskButton.appendChild(unassigned);
          }
          step.appendChild(taskButton);
        }
        row.appendChild(step);
      }
      group.appendChild(row); content.appendChild(group);
    }
  }

  function openFlow() {
    flowOpen = true;
    el("mindmapSvg").hidden = true;
    el("flowView").hidden = false;
    renderFlow();
    el("agentFlowBtn").setAttribute("aria-pressed", "true");
  }

  function closeFlow() {
    flowOpen = false;
    el("mindmapSvg").hidden = false;
    el("flowView").hidden = true;
    el("agentFlowBtn").setAttribute("aria-pressed", "false");
  }

  function zoomAt(newZoom, px, py) {
    const next = Math.max(.18, Math.min(2.5, newZoom));
    const ratio = next / zoom;
    panX = px - (px - panX) * ratio;
    panY = py - (py - panY) * ratio;
    zoom = next;
    applyTransform();
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.style.display = "none";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFilename(value) {
    return (value || "mindmap").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mindmap";
  }

  function exportJson() {
    saveCurrentMap(false);
    downloadFile(`${safeFilename(map.title)}.mindmap.json`, `${JSON.stringify(map, null, 2)}\n`, "application/json");
    showToast("Native mindmap JSON exported.");
  }

  function exportMarkdown() {
    downloadFile(`${safeFilename(map.title)}.md`, Core.toMarkdown(map), "text/markdown;charset=utf-8");
    showToast("Markdown outline exported.");
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast("Import is limited to 10 MB."); return; }
    try {
      const content = await file.text();
      const trimmed = content.trim();
      let next;
      if (file.name.toLowerCase().endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
        next = Core.parseJson(content);
      } else {
        next = Core.fromMarkdown(content, { title: file.name.replace(/\.(md|markdown|txt)$/i, "") || "Imported mindmap", theme: map.theme });
      }
      next.id = Core.uid("map");
      next.updatedAt = new Date().toISOString();
      pushUndo();
      map = Core.normalizeMap(next);
      selectedNodeId = getRoot().id;
      initializeCollapsed();
      closeFlow(); renderAll(); saveCurrentMap(false);
      fitCanvas();
      showToast(`Imported ${file.name}.`);
    } catch (error) {
      showToast(`Could not import map: ${error.message}`);
    } finally {
      el("fileInput").value = "";
    }
  }

  function createModal(title, contentNode, actions) {
    el("modalTitle").textContent = title;
    el("modalBody").replaceChildren(contentNode);
    const foot = el("modalFoot"); foot.replaceChildren();
    for (const action of actions || []) foot.appendChild(action);
    el("modalBackdrop").hidden = false;
    el("modalCloseBtn").focus();
  }

  function closeModal() { el("modalBackdrop").hidden = true; }

  function makeButton(label, className, callback) {
    const button = document.createElement("button"); button.type = "button"; button.className = `btn ${className || ""}`.trim(); button.textContent = label;
    button.addEventListener("click", callback); return button;
  }

  function openLibrary() {
    saveCurrentMap(false);
    const body = document.createElement("div");
    const intro = document.createElement("p"); intro.textContent = "Saved maps are stored in this browser profile. Export JSON for a portable backup or to move a map to another device."; body.appendChild(intro);
    const list = document.createElement("div"); list.className = "library-list";
    const sorted = [...library].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    for (const item of sorted) {
      const row = document.createElement("div"); row.className = "library-row";
      const info = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = item.title;
      const meta = document.createElement("small");
      const date = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "Saved locally";
      meta.textContent = `${item.nodes.length} nodes · ${date}${item.id === map.id ? " · current" : ""}`;
      info.append(title, meta);
      const actions = document.createElement("div"); actions.className = "library-actions";
      const open = makeButton(item.id === map.id ? "Current" : "Open", "", () => {
        map = Core.clone(item); selectedNodeId = getRoot().id; undoStack = []; redoStack = []; initializeCollapsed();
        closeModal(); closeFlow(); renderAll(); fitCanvas(); setStatus("Loaded from this browser");
      });
      if (item.id === map.id) open.disabled = true;
      const remove = makeButton("Remove", "danger", () => {
        if (!window.confirm(`Remove the saved copy of “${item.title}” from this browser?`)) return;
        library = library.filter((candidate) => candidate.id !== item.id);
        persistLibrary(); closeModal(); openLibrary();
        showToast("Saved copy removed from browser storage.");
      });
      if (item.id === map.id) { remove.disabled = true; remove.title = "Open another map before removing this saved copy."; }
      actions.append(open, remove); row.append(info, actions); list.appendChild(row);
    }
    if (!sorted.length) {
      const empty = document.createElement("div"); empty.className = "empty-state"; empty.textContent = "No saved maps yet."; list.appendChild(empty);
    }
    body.appendChild(list);
    createModal("My Maps", body, [makeButton("Close", "", closeModal)]);
  }

  function startNewMap() {
    if (!window.confirm("Create a new blank map? The current map is already auto-saved locally.")) return;
    map = Core.makeEmptyMap("Untitled mindmap");
    selectedNodeId = getRoot().id; undoStack = []; redoStack = []; initializeCollapsed();
    closeFlow(); renderAll(); saveCurrentMap(false); fitCanvas();
    showToast("New blank map created.");
  }

  function buildAIPrompt() {
    const schemaHint = `Return a single valid JSON object using this shape:\n{\n  "schemaVersion": 1, "id": "string", "title": "string", "theme": "paper|night|ocean|forest|violet",\n  "nodes": [{"id":"string","parentId":"string|null","title":"string","notes":"string","kind":"topic|workflow|task|gate|agent|constraint","workflowId":"string","flowOrder":1,"agentIds":["agent-id"]}],\n  "agents": [{"id":"string","name":"string","model":"string","role":"string","summary":"3 or 4 words"}],\n  "sources": [{"title":"string","path":"string","note":"string"}]\n}`;
    return [
      "Help expand this mindmap while preserving factual accuracy and its existing structure.",
      "Return only valid JSON, with no Markdown fences or commentary. Preserve existing node and agent IDs where possible.",
      "Do not invent completed work, current status, model assignments, or source-backed facts. Mark proposals as proposed/design-only in notes.",
      "For each assigned agent, include a 3–4 word summary of what they do. A role may be blank when the source does not specify it; do not force an assignment when the Markdown leaves it open.",
      "Keep workflowId and flowOrder on task nodes intended for the Agent Flow view. Keep source paths and add any new Markdown sources used.",
      "Review the full current map below before sharing it with an external AI; it may contain private notes.",
      "\nJSON shape:\n" + schemaHint,
      "\nCurrent map JSON:\n" + JSON.stringify(map, null, 2)
    ].join("\n");
  }

  function cleanJsonResponse(value) {
    let result = value.trim();
    const fenced = result.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) result = fenced[1];
    return result;
  }

  function openAiWorkbench() {
    const body = document.createElement("div");
    const intro = document.createElement("p");
    intro.textContent = "This local app has no model connection or API key. Copy the prompt to an AI you choose, then paste its JSON response below. Review the prompt first; it includes the current map.";
    body.appendChild(intro);
    const prompt = document.createElement("textarea"); prompt.className = "prompt"; prompt.readOnly = true; prompt.value = buildAIPrompt(); prompt.setAttribute("aria-label", "AI expansion prompt"); body.appendChild(prompt);
    const responseLabel = document.createElement("p"); responseLabel.textContent = "Paste the AI's complete JSON map response:"; body.appendChild(responseLabel);
    const response = document.createElement("textarea"); response.placeholder = "{ \"schemaVersion\": 1, ... }"; response.setAttribute("aria-label", "AI JSON response"); body.appendChild(response);
    const copy = makeButton("Copy prompt", "", async () => {
      await copyText(prompt.value, "AI prompt copied. Review it before sharing.");
    });
    const apply = makeButton("Validate and apply JSON", "primary", () => {
      try {
        const next = Core.parseJson(cleanJsonResponse(response.value));
        next.id = map.id;
        next.updatedAt = new Date().toISOString();
        pushUndo(); map = Core.normalizeMap(next); selectedNodeId = getRoot().id;
        initializeCollapsed(); closeModal(); closeFlow(); renderAll(); saveCurrentMap(false); fitCanvas();
        showToast("AI map validated and applied. Export JSON to keep a portable copy.");
      } catch (error) {
        showToast(`AI response was not applied: ${error.message}`);
      }
    });
    createModal("Build up this map with AI", body, [copy, makeButton("Close", "", closeModal), apply]);
  }

  async function copyText(value, successMessage) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage || "Copied to clipboard.");
      return;
    } catch (_) {
      const area = document.createElement("textarea"); area.value = value; area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select();
      const ok = document.execCommand("copy"); area.remove();
      showToast(ok ? (successMessage || "Copied to clipboard.") : "Copy was blocked. Select and copy the text manually.");
    }
  }

  function initPanZoom() {
    svg.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".map-node") || flowOpen) return;
      panning = { x: event.clientX, y: event.clientY, panX, panY };
      svg.classList.add("panning");
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", (event) => {
      if (!panning) return;
      panX = panning.panX + event.clientX - panning.x;
      panY = panning.panY + event.clientY - panning.y;
      applyTransform();
    });
    function stopPan() { panning = null; svg.classList.remove("panning"); }
    svg.addEventListener("pointerup", stopPan);
    svg.addEventListener("pointercancel", stopPan);
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      zoomAt(zoom * Math.exp(-event.deltaY * .0012), event.clientX - bounds.left, event.clientY - bounds.top);
    }, { passive: false });
    svg.addEventListener("click", (event) => {
      if (!event.target.closest(".map-node")) { selectedNodeId = null; renderNodeEditor(); renderMap(); }
    });
  }

  function attachEvents() {
    el("newMapBtn").addEventListener("click", startNewMap);
    el("libraryBtn").addEventListener("click", openLibrary);
    el("saveBtn").addEventListener("click", () => saveCurrentMap(true));
    el("exportJsonBtn").addEventListener("click", exportJson);
    el("exportMarkdownBtn").addEventListener("click", exportMarkdown);
    el("aiBtn").addEventListener("click", openAiWorkbench);
    el("fileInput").addEventListener("change", (event) => importFile(event.target.files[0]));
    el("themeSelect").addEventListener("change", () => recordEdit(() => { map.theme = el("themeSelect").value; }, { renderMap: false }));
    el("addChildBtn").addEventListener("click", addChildNode);
    el("addAgentBtn").addEventListener("click", addAgent);
    el("tabNode").addEventListener("click", () => setActiveTab("node"));
    el("tabAgents").addEventListener("click", () => setActiveTab("agents"));
    el("tabSources").addEventListener("click", () => setActiveTab("sources"));
    el("undoBtn").addEventListener("click", undo);
    el("redoBtn").addEventListener("click", redo);
    el("zoomInBtn").addEventListener("click", () => {
      const rect = canvasWrap.getBoundingClientRect(); zoomAt(zoom * 1.2, rect.width / 2, rect.height / 2);
    });
    el("zoomOutBtn").addEventListener("click", () => {
      const rect = canvasWrap.getBoundingClientRect(); zoomAt(zoom / 1.2, rect.width / 2, rect.height / 2);
    });
    el("fitBtn").addEventListener("click", fitCanvas);
    el("agentFlowBtn").addEventListener("click", () => flowOpen ? closeFlow() : openFlow());
    el("closeFlowBtn").addEventListener("click", closeFlow);
    el("flowFilter").addEventListener("change", renderFlow);
    el("modalCloseBtn").addEventListener("click", closeModal);
    el("modalBackdrop").addEventListener("click", (event) => { if (event.target === el("modalBackdrop")) closeModal(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !el("modalBackdrop").hidden) closeModal(); });
    window.addEventListener("resize", fitCanvas);

    canvasWrap.addEventListener("dragover", (event) => { event.preventDefault(); });
    canvasWrap.addEventListener("drop", (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) importFile(file);
    });
    initPanZoom();
  }

  function boot() {
    library = loadLibrary();
    const currentId = safeLocalStorageGet(CURRENT_KEY);
    const current = library.find((item) => item.id === currentId);
    if (current) {
      map = Core.clone(current);
    } else {
      try { map = Core.normalizeMap(window.MINDMAP_SAMPLE); }
      catch (error) { map = Core.makeEmptyMap("Mindmap Studio"); console.error(error); }
      library = library.filter((item) => item.id !== map.id);
      library.unshift(Core.clone(map));
      try {
        localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
        localStorage.setItem(CURRENT_KEY, map.id);
      } catch (_) { /* The map remains usable; export is the portable save path. */ }
    }
    selectedNodeId = getRoot().id;
    initializeCollapsed();
    attachEvents();
    renderAll();
    setStatus("Auto-saves in this browser · export JSON for backup");
    requestAnimationFrame(fitCanvas);
  }

  boot();
})();
