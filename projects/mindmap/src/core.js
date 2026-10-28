(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MindmapCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_NODES = 5000;
  const MAX_AGENTS = 300;
  const MAX_TEXT = 12000;

  function uid(prefix) {
    const random = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replaceAll("-", "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `${prefix || "id"}-${random.slice(0, 16)}`;
  }

  function text(value, fallback) {
    const result = typeof value === "string" ? value.trim() : "";
    return (result || fallback || "").slice(0, MAX_TEXT);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function makeEmptyMap(title) {
    const mapTitle = text(title, "Untitled mindmap");
    return {
      schemaVersion: 1,
      id: uid("map"),
      title: mapTitle,
      theme: "paper",
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: uid("node"), parentId: null, title: mapTitle, notes: "Add a child node to begin.",
        kind: "root", workflowId: "", flowOrder: null, agentIds: []
      }],
      agents: [],
      sources: []
    };
  }

  function normalizeMap(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("A mindmap JSON file must contain an object.");
    }
    if (!Array.isArray(input.nodes)) throw new TypeError("The mindmap is missing its nodes array.");
    if (input.nodes.length > MAX_NODES) throw new RangeError(`A map can contain at most ${MAX_NODES} nodes.`);
    if (Array.isArray(input.agents) && input.agents.length > MAX_AGENTS) {
      throw new RangeError(`A map can contain at most ${MAX_AGENTS} agents.`);
    }

    const agents = [];
    const agentIds = new Set();
    for (const raw of Array.isArray(input.agents) ? input.agents : []) {
      if (!raw || typeof raw !== "object") continue;
      const id = text(raw.id, uid("agent")).slice(0, 80);
      if (agentIds.has(id)) throw new TypeError(`Duplicate agent id: ${id}`);
      agentIds.add(id);
      agents.push({
        id,
        name: text(raw.name, id),
        model: text(raw.model),
        role: text(raw.role),
        summary: text(raw.summary, "Assigned work not specified").slice(0, 120)
      });
    }

    let nodes = Array.from(input.nodes, (raw) => {
      if (!raw || typeof raw !== "object") throw new TypeError("Each node must be an object.");
      const id = text(raw.id, uid("node")).slice(0, 80);
      const order = Number(raw.flowOrder);
      return {
        id,
        parentId: raw.parentId == null || raw.parentId === "" ? null : String(raw.parentId).slice(0, 80),
        title: text(raw.title, "Untitled node"),
        notes: text(raw.notes),
        kind: text(raw.kind, "topic").slice(0, 40),
        workflowId: text(raw.workflowId).slice(0, 80),
        flowOrder: Number.isFinite(order) && order > 0 ? Math.floor(order) : null,
        agentIds: Array.isArray(raw.agentIds) ? [...new Set(raw.agentIds.map(String).map((id) => id.slice(0, 80)).filter(Boolean))] : []
      };
    });

    const nodeById = new Map();
    for (const node of nodes) {
      if (nodeById.has(node.id)) throw new TypeError(`Duplicate node id: ${node.id}`);
      nodeById.set(node.id, node);
    }
    if (!nodes.length) {
      const empty = makeEmptyMap(input.title);
      nodes = empty.nodes;
      nodeById.set(nodes[0].id, nodes[0]);
    }

    const roots = nodes.filter((node) => node.parentId === null);
    if (!roots.length) throw new TypeError("The map has no root node.");
    let rootNode;
    if (roots.length > 1) {
      rootNode = {
        id: uid("node"), parentId: null, title: text(input.title, "Imported mindmap"), notes: "",
        kind: "root", workflowId: "", flowOrder: null, agentIds: []
      };
      for (const node of roots) node.parentId = rootNode.id;
      nodes.unshift(rootNode);
      nodeById.set(rootNode.id, rootNode);
    } else {
      rootNode = roots[0];
    }

    for (const node of nodes) {
      if (node.parentId && !nodeById.has(node.parentId)) {
        throw new TypeError(`Node “${node.title}” refers to missing parent ${node.parentId}.`);
      }
      if (node.parentId === node.id) throw new TypeError(`Node “${node.title}” cannot be its own parent.`);
    }
    for (const node of nodes) {
      const seen = new Set([node.id]);
      let parentId = node.parentId;
      while (parentId) {
        if (seen.has(parentId)) throw new TypeError("The map contains a parent cycle.");
        seen.add(parentId);
        parentId = nodeById.get(parentId).parentId;
      }
    }

    const knownAgentIds = new Set(agents.map((agent) => agent.id));
    for (const node of nodes) {
      for (const agentId of node.agentIds) {
        if (!knownAgentIds.has(agentId)) {
          agents.push({ id: agentId, name: agentId, model: "", role: "", summary: "Assigned work not specified" });
          knownAgentIds.add(agentId);
        }
      }
    }

    const mapTitle = text(input.title, rootNode.title || "Untitled mindmap");
    rootNode.title = mapTitle;
    const sources = Array.from(Array.isArray(input.sources) ? input.sources : []).slice(0, 200).map((source) => {
      if (typeof source === "string") return { title: source, path: "", note: "" };
      if (!source || typeof source !== "object") return null;
      return {
        title: text(source.title, "Source"),
        path: text(source.path).slice(0, 1000),
        note: text(source.note).slice(0, 2000)
      };
    }).filter(Boolean);

    return {
      schemaVersion: 1,
      id: text(input.id, uid("map")).slice(0, 100),
      title: mapTitle,
      theme: ["paper", "night", "ocean", "forest", "violet"].includes(input.theme) ? input.theme : "paper",
      updatedAt: text(input.updatedAt, new Date().toISOString()),
      nodes,
      agents,
      sources
    };
  }

  function countWords(value) {
    return text(value).split(/\s+/).filter(Boolean).length;
  }

  function summaryIsThreeOrFourWords(value) {
    const count = countWords(value);
    return count >= 3 && count <= 4;
  }

  function stripInlineMarkdown(value) {
    return String(value)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/(^|[^\\])([*_`~]{1,3})(.*?)\2/g, "$1$3")
      .replace(/\\([\\`*_{}\[\]()#+.!|>-])/g, "$1")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
  }

  function parseListLine(raw) {
    const match = raw.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (!match) return null;
    const indent = match[1].replace(/\t/g, "  ").length;
    return { indent, content: match[2].trim() };
  }

  function parseNodeLine(raw) {
    let content = raw.trim();
    let metadata = {};
    const metaMatch = content.match(/\s*⟦([^⟧]*)⟧\s*$/);
    if (metaMatch) {
      for (const item of metaMatch[1].split(";")) {
        const [key, ...parts] = item.split("=");
        const value = parts.join("=").trim();
        if (key && value) metadata[key.trim().toLowerCase()] = value;
      }
      content = content.slice(0, metaMatch.index).trim();
    }
    let notes = "";
    const noteIndex = content.lastIndexOf(" — ");
    if (noteIndex >= 0) {
      notes = stripInlineMarkdown(content.slice(noteIndex + 3));
      content = content.slice(0, noteIndex).trim();
    }
    const title = stripInlineMarkdown(content).replace(/^[-*+]\s+/, "");
    const order = Number(metadata.order);
    return {
      title: title || "Untitled node",
      notes,
      kind: metadata.type || "topic",
      workflowId: metadata.flow || "",
      flowOrder: Number.isFinite(order) && order > 0 ? Math.floor(order) : null,
      agentIds: metadata.agents ? metadata.agents.split(",").map((id) => id.trim()).filter(Boolean) : []
    };
  }

  function fromMarkdown(markdown, options) {
    if (typeof markdown !== "string") throw new TypeError("Markdown content must be text.");
    const opts = options || {};
    const nodes = [];
    const headingNodes = new Map();
    const listStack = [];
    let currentHeadingLevel = 0;
    let root = null;
    let sawContent = false;
    const lines = markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "").split(/\r?\n/);

    function addNode(parsed, parentId) {
      const node = { id: uid("node"), parentId, ...parsed };
      nodes.push(node);
      return node;
    }

    for (const line of lines) {
      if (!line.trim() || /^\s*```/.test(line) || /^\s*>/.test(line)) continue;
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        const parsed = parseNodeLine(heading[2]);
        if (!root) {
          root = addNode({ ...parsed, kind: "root" }, null);
          headingNodes.set(level, root);
        } else {
          let parent = root;
          for (let previous = level - 1; previous >= 1; previous--) {
            if (headingNodes.has(previous)) { parent = headingNodes.get(previous); break; }
          }
          const node = addNode(parsed, parent.id);
          headingNodes.set(level, node);
        }
        for (const key of [...headingNodes.keys()]) if (key > level) headingNodes.delete(key);
        currentHeadingLevel = level;
        listStack.length = 0;
        sawContent = true;
        continue;
      }
      const list = parseListLine(line);
      if (list) {
        if (!root) root = addNode({ title: text(opts.title, "Imported mindmap"), notes: "", kind: "root", workflowId: "", flowOrder: null, agentIds: [] }, null);
        const headingParent = headingNodes.get(currentHeadingLevel) || root;
        const depth = Math.floor(list.indent / 2);
        const parent = depth === 0 ? headingParent : (listStack[depth - 1] || headingParent);
        const node = addNode(parseNodeLine(list.content), parent.id);
        listStack[depth] = node;
        listStack.length = depth + 1;
        sawContent = true;
        continue;
      }
      if (!sawContent && line.trim()) {
        const parsed = parseNodeLine(line);
        root = addNode({ ...parsed, kind: "root" }, null);
        headingNodes.set(1, root);
        currentHeadingLevel = 1;
        sawContent = true;
      }
    }

    if (!root) return makeEmptyMap(opts.title || "Imported mindmap");
    const title = text(root.title, opts.title || "Imported mindmap");
    return normalizeMap({ id: uid("map"), title, theme: opts.theme || "paper", nodes, agents: [], sources: opts.sources || [] });
  }

  function toMarkdown(input) {
    const map = normalizeMap(input);
    const byParent = new Map();
    for (const node of map.nodes) {
      const key = node.parentId || "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(node);
    }
    const rootNode = map.nodes.find((node) => node.parentId === null);
    function metadataSuffix(node) {
      const meta = [];
      if (node.kind && node.kind !== "topic" && node.kind !== "root") meta.push(`type=${node.kind}`);
      if (node.workflowId) meta.push(`flow=${node.workflowId}`);
      if (node.flowOrder) meta.push(`order=${node.flowOrder}`);
      if (node.agentIds.length) meta.push(`agents=${node.agentIds.join(",")}`);
      return meta.length ? ` ⟦${meta.join("; ")}⟧` : "";
    }
    const rootNote = rootNode?.notes ? ` — ${rootNode.notes.replace(/\r?\n/g, " ")}` : "";
    const lines = [`# ${map.title}${rootNote}${rootNode ? metadataSuffix(rootNode) : ""}`, ""];
    function visit(parent, depth) {
      for (const node of byParent.get(parent.id) || []) {
        const note = node.notes ? ` — ${node.notes.replace(/\r?\n/g, " ")}` : "";
        lines.push(`${"  ".repeat(depth)}- ${node.title}${note}${metadataSuffix(node)}`);
        visit(node, depth + 1);
      }
    }
    if (rootNode) visit(rootNode, 0);
    lines.push("", "<!-- Native JSON preserves agent details, theme, and source metadata. -->", "");
    return lines.join("\n");
  }

  function parseJson(textValue) {
    let value;
    try { value = JSON.parse(textValue); }
    catch (error) { throw new TypeError(`Invalid JSON: ${error.message}`); }
    return normalizeMap(value);
  }

  return {
    uid,
    clone,
    makeEmptyMap,
    normalizeMap,
    countWords,
    summaryIsThreeOrFourWords,
    fromMarkdown,
    toMarkdown,
    parseJson,
    MAX_NODES,
    MAX_AGENTS
  };
});
