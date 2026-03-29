(() => {
  const CHATKIT_DOMAIN_KEY_DEFAULT = "domain_pk_localhost_dev";

  const START_SCREEN_PROMPTS = [
    { label: "Change my seat", prompt: "Can you move me to seat 14C?" },
    { label: "Flight status", prompt: "What's the status of flight FLT-123?" },
    {
      label: "Missed connection",
      prompt:
        "My flight from Paris to New York was delayed and I missed my connection to Austin. Also, my checked bag is missing and I need to spend the night in New York. Can you help me?",
    },
  ];

  const SEAT_LAYOUT = {
    business: { title: "Business Class", rows: [1, 2, 3, 4], seatsPerRow: ["A", "B", "C", "D"] },
    economyPlus: { title: "Economy Plus", rows: [5, 6, 7, 8], seatsPerRow: ["A", "B", "C", "D", "E", "F"] },
    economy: {
      title: "Economy",
      rows: Array.from({ length: 16 }, (_, i) => i + 9),
      seatsPerRow: ["A", "B", "C", "D", "E", "F"],
    },
  };

  const OCCUPIED_SEATS = new Set([
    "1A",
    "2B",
    "3C",
    "5A",
    "5F",
    "7B",
    "7E",
    "9A",
    "9F",
    "10C",
    "10D",
    "12A",
    "12F",
    "14B",
    "14E",
    "16A",
    "16F",
    "18C",
    "18D",
    "20A",
    "20F",
    "22B",
    "22E",
    "24A",
    "24F",
  ]);

  const EXIT_ROWS = new Set([4, 16]);

  const state = {
    agents: [],
    events: [],
    currentAgent: "",
    guardrails: [],
    context: {},
    threadId: null,
    initialThreadId: null,
    selectedSeat: null,
    handledSeatMapEventIds: new Set(),
  };

  const dom = {
    agentsList: document.getElementById("agents-list"),
    contextList: document.getElementById("context-list"),
    guardrailsList: document.getElementById("guardrails-list"),
    runnerList: document.getElementById("runner-list"),
    threadStatus: document.getElementById("thread-status"),
    threadIdInput: document.getElementById("thread-id-input"),
    loadThreadBtn: document.getElementById("load-thread-btn"),
    refreshBtn: document.getElementById("refresh-btn"),
    closeSeatMapBtn: document.getElementById("close-seat-map-btn"),
    seatMapTray: document.getElementById("seat-map-tray"),
    seatMapRoot: document.getElementById("seat-map-root"),
    chatkitHost: document.getElementById("chatkit-host"),
    chatkitLoading: document.getElementById("chatkit-loading"),
  };

  const guardrailNameMap = {
    relevance_guardrail: "Relevance Guardrail",
    jailbreak_guardrail: "Jailbreak Guardrail",
  };

  const guardrailDescriptionMap = {
    "Relevance Guardrail": "Ensure messages are relevant to airline support",
    "Jailbreak Guardrail": "Detect and block attempts to bypass or override system instructions",
  };

  let chatkitElement = null;
  let stream = null;
  let streamThreadId = null;
  let pollTimer = null;

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function setStatus(text) {
    dom.threadStatus.textContent = text;
  }

  function getDomainKey() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("domainKey");
    const fromWindow = window.CHATKIT_DOMAIN_KEY;
    return fromQuery || fromWindow || CHATKIT_DOMAIN_KEY_DEFAULT;
  }

  async function waitForElementDefinition(elementName, timeoutMs) {
    await Promise.race([
      customElements.whenDefined(elementName),
      new Promise((_, reject) => {
        window.setTimeout(() => {
          reject(new Error(`${elementName} was not defined before timeout`));
        }, timeoutMs);
      }),
    ]);
  }

  function parseTimestamp(value) {
    const parsed = value ? new Date(value) : new Date();
    if (Number.isNaN(parsed.getTime())) {
      return new Date();
    }
    return parsed;
  }

  function normalizeEvents(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const now = Date.now();
    let latestNonProgress = 0;
    for (const event of items) {
      if (event.type === "progress_update") {
        continue;
      }
      const ts = event.timestamp instanceof Date ? event.timestamp.getTime() : parseTimestamp(event.timestamp).getTime();
      if (ts > latestNonProgress) {
        latestNonProgress = ts;
      }
    }

    return items.filter((event) => {
      if (event.type !== "progress_update") {
        return true;
      }
      const ts = event.timestamp instanceof Date ? event.timestamp.getTime() : parseTimestamp(event.timestamp).getTime();
      if (latestNonProgress && ts < latestNonProgress) {
        return false;
      }
      if (now - ts > 15000) {
        return false;
      }
      return true;
    });
  }

  function inlineValue(value) {
    if (value === null || value === undefined || value === "") {
      return "null";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "object";
    }
  }

  function tryParseJson(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "object") {
      return value;
    }
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return null;
  }

  function formatContextValue(value) {
    if (value === null || value === undefined || value === "") {
      return "null";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "[]";
      }
      const primitives = value.every((item) => ["string", "number", "boolean"].includes(typeof item));
      if (primitives && value.length <= 3) {
        return value.join(", ");
      }
      return `${value.length} item${value.length === 1 ? "" : "s"}`;
    }
    if (typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        return "object";
      }
      const preview = keys.slice(0, 3).join(", ");
      return `{${preview}${keys.length > 3 ? ", ..." : ""}}`;
    }
    return String(value);
  }

  function extractGuardrailName(rawName) {
    return guardrailNameMap[rawName] || rawName;
  }

  function formatEventName(type) {
    if (!type) {
      return "Event";
    }
    return (type.charAt(0).toUpperCase() + type.slice(1)).replaceAll("_", " ");
  }

  function buildEventSummary(event) {
    if (event.type === "handoff") {
      return (
        event.content ||
        `${event.metadata?.source_agent || ""} -> ${event.metadata?.target_agent || ""}`.trim()
      );
    }

    if (event.type === "tool_call") {
      const args = event.metadata?.tool_args;
      const argsText = args !== undefined ? ` - ${inlineValue(args)}` : "";
      return `${event.content || "Tool call"}${argsText}`;
    }

    if (event.type === "tool_output") {
      const result = event.metadata?.tool_result;
      if (result !== undefined) {
        return inlineValue(result);
      }
      return event.content || "Tool output";
    }

    if (event.type === "context_update") {
      const changes = event.metadata?.changes;
      if (!changes || typeof changes !== "object") {
        return event.content || "";
      }
      return Object.entries(changes)
        .map(([key, value]) => `${key}: ${inlineValue(value)}`)
        .join(" | ");
    }

    return event.content || "";
  }

  function groupRunnerEvents(events) {
    const groups = [];
    for (let i = 0; i < events.length; i += 1) {
      const current = events[i];
      if (current.type === "tool_call") {
        const group = [current];
        let j = i + 1;
        while (
          j < events.length &&
          events[j].type === "tool_output" &&
          events[j].agent === current.agent
        ) {
          group.push(events[j]);
          j += 1;
        }
        groups.push(group);
        i = j - 1;
      } else {
        groups.push([current]);
      }
    }
    return groups;
  }

  function getSeatStatus(seatNumber) {
    if (OCCUPIED_SEATS.has(seatNumber)) {
      return "occupied";
    }
    if (state.selectedSeat === seatNumber) {
      return "selected";
    }
    return "available";
  }

  function seatButtonClass(status, isExit) {
    if (status === "occupied") {
      return "seat-btn occupied";
    }
    if (status === "selected") {
      return "seat-btn selected";
    }
    if (isExit) {
      return "seat-btn available exit";
    }
    return "seat-btn available";
  }

  function renderSeatSection(section) {
    const firstHalf = section.seatsPerRow.slice(0, Math.ceil(section.seatsPerRow.length / 2));
    const secondHalf = section.seatsPerRow.slice(Math.ceil(section.seatsPerRow.length / 2));

    const rowsHtml = section.rows
      .map((row) => {
        const isExitRow = EXIT_ROWS.has(row);

        const leftSeats = firstHalf
          .map((letter) => {
            const seat = `${row}${letter}`;
            const status = getSeatStatus(seat);
            const className = seatButtonClass(status, isExitRow);
            const disabled = status === "occupied" ? "disabled" : "";
            return `<button type="button" class="${className}" data-seat="${seat}" ${disabled}>${letter}</button>`;
          })
          .join("");

        const rightSeats = secondHalf
          .map((letter) => {
            const seat = `${row}${letter}`;
            const status = getSeatStatus(seat);
            const className = seatButtonClass(status, isExitRow);
            const disabled = status === "occupied" ? "disabled" : "";
            return `<button type="button" class="${className}" data-seat="${seat}" ${disabled}>${letter}</button>`;
          })
          .join("");

        return `
          <div class="seat-row">
            <span class="seat-row-label">${row}</span>
            ${leftSeats}
            <span class="seat-aisle"></span>
            ${rightSeats}
          </div>
        `;
      })
      .join("");

    return `
      <section class="seat-section">
        <h4>${escapeHtml(section.title)}</h4>
        ${rowsHtml}
      </section>
    `;
  }

  function renderSeatMap() {
    const html = `
      <div class="seat-map-card">
        <h3 class="seat-map-title">Select Your Seat</h3>
        <div class="seat-legend">
          <span class="seat-legend-item"><span class="seat-legend-dot available"></span>Available</span>
          <span class="seat-legend-item"><span class="seat-legend-dot occupied"></span>Occupied</span>
          <span class="seat-legend-item"><span class="seat-legend-dot exit"></span>Exit Row</span>
        </div>
        ${renderSeatSection(SEAT_LAYOUT.business)}
        ${renderSeatSection(SEAT_LAYOUT.economyPlus)}
        ${renderSeatSection(SEAT_LAYOUT.economy)}
        ${
          state.selectedSeat
            ? `<p class="selected-seat-pill">Selected: Seat ${escapeHtml(state.selectedSeat)}</p>`
            : ""
        }
      </div>
    `;

    dom.seatMapRoot.innerHTML = html;

    const seatButtons = dom.seatMapRoot.querySelectorAll("button[data-seat]");
    for (const button of seatButtons) {
      button.addEventListener("click", () => {
        const seat = button.getAttribute("data-seat");
        if (seat) {
          void handleSeatSelect(seat);
        }
      });
    }
  }

  function showSeatMap() {
    renderSeatMap();
    dom.seatMapTray.classList.remove("hidden");
  }

  function hideSeatMap() {
    dom.seatMapTray.classList.add("hidden");
  }

  function maybeShowSeatMapFromEvents(events) {
    for (const event of events) {
      if (event.type !== "tool_output") {
        continue;
      }
      if (state.handledSeatMapEventIds.has(event.id)) {
        continue;
      }
      const toolResult = String(event.metadata?.tool_result ?? "");
      const content = String(event.content ?? "");
      if (toolResult.includes("DISPLAY_SEAT_MAP") || content.includes("DISPLAY_SEAT_MAP")) {
        state.handledSeatMapEventIds.add(event.id);
        showSeatMap();
        break;
      }
    }
  }

  function renderAgents() {
    const activeAgent = state.agents.find((agent) => agent.name === state.currentAgent);
    if (!state.agents.length) {
      dom.agentsList.innerHTML = '<div class="empty">No agents loaded yet</div>';
      return;
    }

    const html = state.agents
      .map((agent) => {
        const isActive = agent.name === state.currentAgent;
        const canHandoff = Array.isArray(activeAgent?.handoffs) && activeAgent.handoffs.includes(agent.name);
        const isDimmed = !isActive && !canHandoff;

        return `
          <article class="card ${isActive ? "is-active" : ""} ${isDimmed ? "is-dimmed" : ""}">
            <h3>${escapeHtml(agent.name)}</h3>
            <p>${escapeHtml(agent.description || "")}</p>
            ${isActive ? '<span class="badge blue">Active</span>' : ""}
          </article>
        `;
      })
      .join("");

    dom.agentsList.innerHTML = html;
  }

  function renderContext() {
    const entries = Object.entries(state.context || {});
    if (!entries.length) {
      dom.contextList.innerHTML = '<div class="empty">No conversation context yet</div>';
      return;
    }

    const html = entries
      .map(([key, value]) => {
        const rendered = formatContextValue(value);
        return `
          <article class="card context-item">
            <div class="context-dot"></div>
            <div>
              <p class="context-k">${escapeHtml(key)}:</p>
              <p class="context-v">${escapeHtml(rendered)}</p>
            </div>
          </article>
        `;
      })
      .join("");

    dom.contextList.innerHTML = html;
  }

  function renderGuardrails() {
    const activeAgent = state.agents.find((agent) => agent.name === state.currentAgent);
    const inputGuardrails = Array.isArray(activeAgent?.input_guardrails) ? activeAgent.input_guardrails : [];

    if (!inputGuardrails.length) {
      dom.guardrailsList.innerHTML = '<div class="empty">No guardrails declared for the active agent</div>';
      return;
    }

    const guardrailsToShow = inputGuardrails.map((rawName) => {
      const existing = state.guardrails.find((gr) => gr.name === rawName);
      if (existing) {
        return existing;
      }
      return {
        id: rawName,
        name: rawName,
        input: "",
        reasoning: "",
        passed: false,
      };
    });

    const html = guardrailsToShow
      .map((guardrail) => {
        const title = extractGuardrailName(guardrail.name);
        const description = guardrailDescriptionMap[title] || guardrail.input || "";
        const passed = !guardrail.input || guardrail.passed;
        return `
          <article class="card">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description)}</p>
            <span class="badge ${passed ? "good" : "bad"}">${passed ? "Passed" : "Failed"}</span>
          </article>
        `;
      })
      .join("");

    dom.guardrailsList.innerHTML = html;
  }

  function eventExpandedIds() {
    return new Set(
      Array.from(dom.runnerList.querySelectorAll("details[data-event-id][open]"))
        .map((node) => node.getAttribute("data-event-id"))
        .filter(Boolean)
    );
  }

  function renderRunnerOutput() {
    const expandedIds = eventExpandedIds();
    const runnerEvents = state.events.filter((event) => event.type !== "message" && event.type !== "progress_update");

    if (!runnerEvents.length) {
      dom.runnerList.innerHTML = '<div class="empty">No runner events yet</div>';
      return;
    }

    const grouped = groupRunnerEvents(runnerEvents);
    const html = grouped
      .map((group) => {
        const groupKey = group.map((ev) => ev.id).join("-");
        const agentName = group[0]?.agent || "Agent";

        const eventsHtml = group
          .map((event) => {
            const toolArgs = event.metadata?.tool_args;
            const toolResult = event.metadata?.tool_result;
            const contextChanges = event.metadata?.changes;
            const parsedArgs = tryParseJson(toolArgs);
            const parsedResult = tryParseJson(toolResult);
            const parsedContext = tryParseJson(contextChanges);
            const detailsValue =
              event.type === "tool_call"
                ? JSON.stringify(parsedArgs ?? toolArgs ?? {}, null, 2)
                : event.type === "tool_output"
                  ? JSON.stringify(parsedResult ?? toolResult ?? {}, null, 2)
                  : event.type === "context_update"
                    ? JSON.stringify(parsedContext ?? contextChanges ?? {}, null, 2)
                    : buildEventSummary(event);
            const openAttr = expandedIds.has(event.id) ? "open" : "";

            return `
              <details class="event-detail" data-event-id="${escapeHtml(event.id)}" ${openAttr}>
                <summary>
                  <span class="event-type">${escapeHtml(formatEventName(event.type))}</span>
                  <span class="event-summary ${event.type === "tool_call" ? "mono" : ""}">${escapeHtml(buildEventSummary(event))}</span>
                </summary>
                <pre class="event-content mono">${escapeHtml(detailsValue)}</pre>
              </details>
            `;
          })
          .join("");

        return `
          <article class="card" data-group-id="${escapeHtml(groupKey)}">
            <div class="event-group-header">${escapeHtml(agentName)}</div>
            ${eventsHtml}
          </article>
        `;
      })
      .join("");

    dom.runnerList.innerHTML = html;
  }

  function renderAll() {
    renderAgents();
    renderContext();
    renderGuardrails();
    renderRunnerOutput();

    dom.threadIdInput.value = state.threadId || "";
  }

  async function fetchJson(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json();
  }

  function applySnapshot(data, fromBootstrap) {
    if (!data || typeof data !== "object") {
      return;
    }

    if (fromBootstrap) {
      state.initialThreadId = data.thread_id || null;
    }

    if (data.thread_id) {
      state.threadId = data.thread_id;
    }

    state.currentAgent = data.current_agent || "";
    state.context = data.context && typeof data.context === "object" ? data.context : {};

    if (Array.isArray(data.agents)) {
      state.agents = data.agents;
    }

    if (Array.isArray(data.events)) {
      state.events = normalizeEvents(
        data.events.map((event) => ({
          ...event,
          timestamp: parseTimestamp(event.timestamp),
        }))
      );
      maybeShowSeatMapFromEvents(state.events);
    }

    if (Array.isArray(data.guardrails)) {
      state.guardrails = data.guardrails.map((guardrail) => ({
        ...guardrail,
        timestamp: parseTimestamp(guardrail.timestamp),
      }));
    }

    renderAll();
  }

  function closeStream() {
    if (stream) {
      stream.close();
      stream = null;
    }
    streamThreadId = null;
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (!state.threadId) {
      return;
    }
    pollTimer = window.setInterval(() => {
      void hydrateState(state.threadId);
    }, 3000);
  }

  function connectStream(threadId) {
    if (!threadId) {
      closeStream();
      stopPolling();
      return;
    }

    if (stream && streamThreadId === threadId) {
      return;
    }

    closeStream();
    stopPolling();

    streamThreadId = threadId;
    stream = new EventSource(`/chatkit/state/stream?thread_id=${encodeURIComponent(threadId)}`);

    stream.onopen = () => {
      setStatus(`Thread ${threadId} - live updates connected`);
      stopPolling();
    };

    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        applySnapshot(payload, false);
      } catch (error) {
        console.error("Failed to parse state stream message", error);
      }
    };

    stream.onerror = () => {
      closeStream();
      setStatus(`Thread ${threadId} - live stream unavailable, polling every 3s`);
      startPolling();
    };
  }

  async function hydrateState(threadId) {
    if (!threadId) {
      return;
    }

    try {
      const data = await fetchJson(`/chatkit/state?thread_id=${encodeURIComponent(threadId)}`);
      applySnapshot(data, false);
      setStatus(`Thread ${threadId} - loaded`);
    } catch (error) {
      console.error("Error fetching thread state", error);
      setStatus(`Thread ${threadId} - failed to load`);
    }
  }

  async function onThreadChange(threadId, source) {
    if (!threadId) {
      state.threadId = null;
      closeStream();
      stopPolling();
      dom.threadIdInput.value = "";
      setStatus(`No active thread (${source})`);
      return;
    }

    if (state.threadId === threadId && streamThreadId === threadId) {
      return;
    }

    state.threadId = threadId;
    dom.threadIdInput.value = threadId;
    setStatus(`Thread ${threadId} - loading (${source})`);
    await hydrateState(threadId);
    connectStream(threadId);
  }

  function onChatKitEffect(detail) {
    const name = detail?.name;
    const data = detail?.data;

    if (name === "runner_bind_thread") {
      const threadId = data?.thread_id;
      if (threadId) {
        void onThreadChange(threadId, "runner_bind_thread");
      }
      return;
    }

    if (name === "runner_state_update" || name === "runner_event_delta") {
      if (state.threadId) {
        void hydrateState(state.threadId);
      }
    }
  }

  async function initChatKit() {
    if (!window.customElements) {
      setStatus("Browser does not support custom elements");
      return;
    }

    try {
      await waitForElementDefinition("openai-chatkit", 10000);
    } catch (error) {
      console.error("ChatKit custom element failed to define", error);
      setStatus("ChatKit failed to initialize");
      return;
    }

    chatkitElement = document.createElement("openai-chatkit");

    chatkitElement.addEventListener("chatkit.ready", () => {
      if (dom.chatkitLoading) {
        dom.chatkitLoading.remove();
      }
      if (state.threadId) {
        setStatus(`Thread ${state.threadId} - chat ready`);
      } else {
        setStatus("Chat ready - start a conversation");
      }
    });

    chatkitElement.addEventListener("chatkit.thread.change", (event) => {
      const threadId = event.detail?.threadId ?? null;
      void onThreadChange(threadId, "chatkit.thread.change");
    });

    chatkitElement.addEventListener("chatkit.response.end", () => {
      if (state.threadId) {
        void hydrateState(state.threadId);
      }
    });

    chatkitElement.addEventListener("chatkit.effect", (event) => {
      onChatKitEffect(event.detail);
    });

    chatkitElement.addEventListener("chatkit.error", (event) => {
      console.error("ChatKit error", event.detail?.error || event.detail);
    });

    dom.chatkitHost.appendChild(chatkitElement);

    chatkitElement.setOptions({
      api: {
        url: "/chatkit",
        domainKey: getDomainKey(),
      },
      composer: {
        placeholder: "Message...",
      },
      history: {
        enabled: false,
      },
      theme: {
        colorScheme: "light",
        radius: "round",
        density: "normal",
        color: {
          accent: {
            primary: "#2563eb",
            level: 1,
          },
        },
      },
      initialThread: state.initialThreadId ?? null,
      startScreen: {
        greeting: "Hi! I'm your airline assistant. How can I help today?",
        prompts: START_SCREEN_PROMPTS,
      },
      threadItemActions: {
        feedback: false,
      },
    });
  }

  async function sendUserMessage(messageText) {
    if (!chatkitElement || typeof chatkitElement.sendUserMessage !== "function") {
      throw new Error("ChatKit is not ready yet");
    }

    await chatkitElement.sendUserMessage({ text: messageText });
  }

  async function handleSeatSelect(seatNumber) {
    state.selectedSeat = seatNumber;
    renderSeatMap();

    try {
      await sendUserMessage(`Please change my seat to ${seatNumber}.`);
      hideSeatMap();
    } catch (error) {
      console.error("Failed to send seat selection", error);
      setStatus("Could not send seat selection. Ensure chat is ready.");
    }
  }

  async function bootstrap() {
    setStatus("Loading bootstrap state...");

    try {
      const data = await fetchJson("/chatkit/bootstrap");
      applySnapshot(data, true);

      if (state.threadId) {
        setStatus(`Thread ${state.threadId} - loading`);
        await hydrateState(state.threadId);
        connectStream(state.threadId);
      } else {
        setStatus("No active thread yet. Start chatting or load a thread ID.");
      }
    } catch (error) {
      console.error("Error bootstrapping state", error);
      setStatus("Bootstrap failed. Make sure the FastAPI server is running.");
    }
  }

  async function loadThreadFromInput() {
    const threadId = dom.threadIdInput.value.trim();
    if (!threadId) {
      setStatus("Enter a thread ID first");
      return;
    }

    if (chatkitElement && typeof chatkitElement.setThreadId === "function") {
      try {
        await chatkitElement.setThreadId(threadId);
      } catch (error) {
        console.error("Failed to set ChatKit thread", error);
      }
    }

    await onThreadChange(threadId, "manual");
  }

  function wireActions() {
    dom.loadThreadBtn.addEventListener("click", () => {
      void loadThreadFromInput();
    });

    dom.refreshBtn.addEventListener("click", () => {
      if (!state.threadId) {
        setStatus("No thread selected");
        return;
      }
      void hydrateState(state.threadId);
    });

    dom.closeSeatMapBtn.addEventListener("click", () => {
      hideSeatMap();
    });
  }

  async function start() {
    wireActions();
    await bootstrap();
    await initChatKit();
  }

  void start();
})();
