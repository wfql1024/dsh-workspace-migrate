/**
 * dsh-workspace-migrate — browser face.
 *
 * Registers three additive entry points and one dialog:
 *   - sidebar.footer.action              a button in the left sidebar foot (root)
 *   - conversation.session.header.actions a button in the conversation header (session)
 *   - settings.section                    the full "工作区迁移" page
 *   - shell.overlay                       the dialog the two buttons open
 *
 * Every one of those slots is `replaceRisk: none` (additive), so nothing shipped
 * is shadowed. `sidebar.workspaces` — the session list itself — is deliberately
 * NOT touched: it is a `single` slot that would shadow the shipped sidebar.
 *
 * The host half is reached over its own loopback-fenced HTTP routes under
 * /api/dsh-workspace-migrate; no typert schema or RPC carrier is involved.
 *
 * Written as a plain lazy-CJS module for the vendored cordis Loader: no
 * TypeScript, no bundler, no JSX — `react.createElement` throughout.
 */
window.__ModuleLoader__.load({
	id: "dsh-workspace-migrate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region styles
		const CSS = [
			".dwsm-root{display:flex;flex-direction:column;gap:12px;color:inherit;font-size:13px;line-height:1.6;}",
			".dwsm-h1{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}",
			".dwsm-sub{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);opacity:.85;}",
			".dwsm-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px;}",
			".dwsm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
			".dwsm-label{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);min-width:44px;}",
			".dwsm-input,.dwsm-select{flex:1 1 240px;min-width:180px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));font-size:12px;font-family:ui-monospace,Consolas,monospace;}",
			// A native <select> popup is painted by the browser rather than by the page,
			// so `color: inherit` alone leaves white-on-white in dark mode. Both the
			// control and its <option> rows therefore carry explicit theme colors
			// (Blink honors option background-color / color).
			".dwsm-input{background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);}",
			".dwsm-select{background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);}",
			".dwsm-select option{background-color:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#ffffff));color:var(--dsw-alias-label-primary,#1a1a1a);}",
			".dwsm-input::placeholder{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.85));opacity:.75;}",
			".dwsm-btn{padding:6px 12px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));background:transparent;color:inherit;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap;}",
			".dwsm-btn:hover:enabled{border-color:currentColor;}",
			".dwsm-btn:disabled{opacity:.45;cursor:default;}",
			".dwsm-btn-primary{border-color:transparent;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18));font-weight:500;}",
			".dwsm-pre{margin:0;padding:10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:12px;max-height:320px;overflow:auto;}",
			".dwsm-good{color:var(--dsw-alias-state-success-primary,#2da44e);}",
			".dwsm-bad{color:var(--dsw-alias-state-error-primary,#e5534b);}",
			".dwsm-warn{color:var(--dsw-alias-state-warn-primary,#bf8700);}",
			".dwsm-list{display:flex;flex-direction:column;gap:6px;}",
			".dwsm-item{display:flex;gap:8px;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));padding-bottom:6px;}",
			".dwsm-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;}",
			".dwsm-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:24px;}",
			".dwsm-dialog{width:min(760px,92vw);max-height:86vh;overflow:auto;border-radius:12px;padding:16px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-module-platform,#1e1e1e));color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));box-shadow:0 12px 40px rgba(0,0,0,.35);}",
			".dwsm-foot{display:flex;justify-content:flex-end;gap:8px;}",
			".dwsm-entry{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;font-size:12px;font-family:inherit;}",
			".dwsm-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));}",
			".dwsm-entry-icon{display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:1;}",
			// Collapsed sidebar: the owner centers its children in a 56px rail, so the entry becomes a
			// 36x36 icon-only button and the glyph carries the whole label (title/aria-label keep the
			// name available to pointer and screen-reader users).
			".dwsm-entry-rail{flex:none;justify-content:center;gap:0;width:36px;height:36px;padding:0;border-radius:12px;}",
			".dwsm-entry-rail .dwsm-entry-icon{font-size:18px;}",
			".dwsm-modes{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:16px;overflow:hidden;}",
			".dwsm-mode{padding:5px 12px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:12px;font-family:inherit;}",
			".dwsm-mode-on{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,inherit);font-weight:500;}",
			".dwsm-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;}",
			".dwsm-btn-danger{border-color:var(--dsw-alias-state-error-primary,#e5534b);color:var(--dsw-alias-state-error-primary,#e5534b);}",
			// One collapsed summary row per result: chevron + title + status chip, body hidden
			// until the row is opened.
			".dwsm-disc{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;overflow:hidden;}",
			".dwsm-disc-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;}",
			".dwsm-disc-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}",
			".dwsm-disc-body{padding:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));}",
			".dwsm-chev{display:inline-block;width:12px;color:var(--dsw-alias-label-secondary,inherit);}",
			".dwsm-disc-title{font-weight:600;}",
			".dwsm-spacer{flex:1 1 auto;}",
			".dwsm-chip{padding:1px 8px;border-radius:10px;font-size:11px;font-weight:500;border:1px solid transparent;white-space:nowrap;}",
			".dwsm-chip-ok{color:var(--dsw-alias-state-success-primary,#2da44e);border-color:currentColor;}",
			".dwsm-chip-bad{color:var(--dsw-alias-state-error-primary,#e5534b);border-color:currentColor;}",
			".dwsm-chip-warn{color:var(--dsw-alias-state-warn-primary,#bf8700);border-color:currentColor;}",
			".dwsm-chip-info{color:var(--dsw-alias-label-secondary,inherit);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.45));}",
			".dwsm-banner{padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));font-size:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));}",
			".dwsm-hint{padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));font-size:12px;color:var(--dsw-alias-label-secondary,inherit);white-space:pre-wrap;line-height:1.7;}",
			".dwsm-i{width:18px;height:18px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:11px;line-height:1;font-family:inherit;}",
			".dwsm-i:hover{border-color:currentColor;color:var(--dsw-alias-label-primary,inherit);}",
		].join("");
		const CSS_TAG = "dsh-workspace-migrate/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workspace-migrate";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region shared dialog state
		const API_BASE = "/api/dsh-workspace-migrate";
		const listeners = new Set();
		/** Dialog visibility plus the Session it was opened from, when there is one. */
		let dialogState = { open: false, sessionId: null };

		function publish(next) {
			dialogState = next;
			for (const listener of Array.from(listeners)) {
				try {
					listener(dialogState);
				} catch (error) {
					/* a broken subscriber must not break the others */
				}
			}
		}

		/**
		 * Open the dialog. When a Session id is supplied, the panel preselects that
		 * Session's own workspace so the user never has to retype the path they are
		 * already looking at.
		 * @param sessionId - the Session the entry was clicked from, if the seat provides one.
		 */
		function openDialog(sessionId) {
			const id = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
			publish({ open: true, sessionId: id });
		}

		function closeDialog() {
			publish({ open: false, sessionId: null });
		}

		function useDialog() {
			const [value, setValue] = react.useState(dialogState);
			react.useEffect(() => {
				listeners.add(setValue);
				setValue(dialogState);
				return () => {
					listeners.delete(setValue);
				};
			}, []);
			return value;
		}
		//#endregion

		//#region host API
		async function callApi(path, body) {
			const method = body === undefined ? "GET" : "POST";
			const response = await fetch(API_BASE + path, {
				method,
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			return { status: response.status, payload };
		}
		//#endregion

		//#region helpers
		function text(value) {
			return value === undefined || value === null ? "" : String(value);
		}

		/**
		 * Render one host line as-is when it already carries a signal marker.
		 *
		 * The host prefixes every note with `[√]` (done), `[!]` (degraded but handled),
		 * `[×]` (failed) or `[i]` (context) so a note is never mistaken for an error. Unmarked
		 * text — an older host, or a line this dialog builds itself — gets the neutral label.
		 */
		function marked(value) {
			const line = text(value);
			return /^\s*\[[√×!i]\]/.test(line) ? line : "提示: " + line;
		}

		/**
		 * Case-insensitive path equality, for display only: the workspace picker has to show the
		 * workspace currently in「从」as its selected option, and Windows paths differ in case.
		 * The host stays the authority on path identity.
		 */
		function samePathText(a, b) {
			const strip = (value) => text(value).replace(/[\\/]+$/, "");
			const left = strip(a);
			const right = strip(b);
			return left.length > 0 && left.toLowerCase() === right.toLowerCase();
		}

		function CodeLine(props) {
			return react.createElement(
				"pre",
				{ className: "dwsm-pre" },
				props.children,
			);
		}

		/**
		 * One result row: a summary line (chevron + title + status chip + optional actions) whose
		 * body is present in the DOM but hidden until the row is opened.
		 *
		 * `hidden` rather than "do not render" keeps the detail one click away, and keeps the
		 * summary readable without a wall of text underneath every action.
		 */
		function Disclosure(props) {
			const open = props.open === true;
			const head = [
				react.createElement("span", { key: "chev", className: "dwsm-chev", "aria-hidden": "true" }, open ? "▾" : "▸"),
				react.createElement("span", { key: "title", className: "dwsm-disc-title" }, text(props.title)),
			];
			if (props.chip !== undefined && props.chip !== null) {
				head.push(react.createElement("span", { key: "chip", className: "dwsm-chip " + props.chip.className }, text(props.chip.label)));
			}
			// Row actions sit right after the status chip, where the eye already is; the spacer
			// only pushes the remainder of the row out.
			if (props.actions !== undefined && props.actions !== null) head.push(props.actions);
			head.push(react.createElement("span", { key: "spacer", className: "dwsm-spacer" }));
			return react.createElement(
				"div",
				{ className: "dwsm-disc" },
				// A div, not a button: the row can carry its own action buttons (「打开目录」), and a
				// button nested inside a button is invalid HTML.
				react.createElement(
					"div",
					{
						className: "dwsm-disc-head",
						role: "button",
						tabIndex: 0,
						"aria-expanded": open ? "true" : "false",
						onClick: props.onToggle,
						onKeyDown: (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								props.onToggle();
							}
						},
					},
					head,
				),
				react.createElement("div", { className: "dwsm-disc-body", hidden: open ? undefined : true }, props.children),
				// A banner sits between the summary and the detail and is visible either way: it
				// carries what just happened to the row's own button.
				props.banner === undefined || props.banner === null
					? null
					: react.createElement("div", { className: "dwsm-banner" }, props.banner),
				// The hint answers "what do I do with this?", which is a question about the row, so
				// it is not buried inside the collapsible detail.
				props.hint === undefined || props.hint === null
					? null
					: react.createElement("div", { className: "dwsm-hint" }, props.hint),
			);
		}
		//#endregion

		//#region panel
		function Panel(props) {
			const dialog = useDialog();
			const prefillFromSession = props && props.prefillFromSession === true;
			const [state, setState] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [from, setFrom] = react.useState("");
			const [to, setTo] = react.useState("");
			const [plan, setPlan] = react.useState(null);
			const [verify, setVerify] = react.useState(null);
			const [prefilled, setPrefilled] = react.useState(null);
			/**
			 * Manual mode: plan now, run the staged script while DSH is stopped. The live move is
			 * the default because it is the normal path, not an advanced one.
			 */
			const [manual, setManual] = react.useState(false);
			/**
			 * How the destination is reached: move the project's files there too (default), or only
			 * re-point the workspace at a path — one that is created for you when it is missing. A
			 * destination that already holds files is never taken over: the check fails and says so.
			 */
			const [moveFiles, setMoveFiles] = react.useState(true);
			const [liveInspect, setLiveInspect] = react.useState(null);
			const [liveResult, setLiveResult] = react.useState(null);
			/** Which result rows are open; an explicit toggle wins, otherwise the default applies. */
			const [expanded, setExpanded] = react.useState({});
			const rowOpen = (key, defaultOpen) => (expanded[key] === undefined ? defaultOpen === true : expanded[key] === true);
			const toggleRow = (key) => setExpanded((current) => Object.assign({}, current, { [key]: current[key] !== true }));
			/**
			 * Outcome of the last「打开目录」／「清理无法使用的暂存」attempt, attached to the row that
			 * asked for it.
			 *
			 * Launching a file manager produces no visible change inside the page, so without this a
			 * successful request looks exactly like a dead button.
			 */
			const [openNotice, setOpenNotice] = react.useState(null);

			/** Any change to the inputs invalidates a previous live verdict. */
			const editFrom = (value) => {
				setFrom(value);
				setLiveInspect(null);
				setLiveResult(null);
			};
			const editTo = (value) => {
				setTo(value);
				setLiveInspect(null);
				setLiveResult(null);
			};

			/**
			 * The one button that does the work.
			 *
			 * The read-only check runs first and gates the write: a refused check means nothing is
			 * touched, and the row opens so the reason is visible without a second click. A passed
			 * check continues straight into the migration — the two were only ever separate
			 * because the check used to be a manual step.
			 */
			const startMigration = () => {
				if (from.trim().length === 0 || to.trim().length === 0) {
					setError("请先填写「从」和「到」两个路径。");
					return;
				}
				setBusy(true);
				setError(null);
				setLiveInspect(null);
				setLiveResult(null);
				setPlan(null);
				callApi("/live-inspect", { from: from.trim(), to: to.trim(), moveProject: moveFiles }).then(
					(result) => {
						const payload = result.payload;
						if (!(payload && typeof payload.ok === "boolean")) {
							setError(payload && payload.error ? text(payload.error) : "检查失败（HTTP " + text(result.status) + "）");
							setBusy(false);
							return;
						}
						setLiveInspect(payload);
						if (payload.ok !== true) {
							setBusy(false);
							return;
						}
						callApi("/live-move", { from: from.trim(), to: to.trim(), moveProject: moveFiles, confirm: true }).then(
							(moved) => {
								const outcome = moved.payload;
								if (outcome && typeof outcome.ok === "boolean") {
									setLiveResult(outcome);
									if (outcome.ok === true) refresh();
								} else {
									setError(outcome && outcome.error ? text(outcome.error) : "迁移失败（HTTP " + text(moved.status) + "）");
								}
								setBusy(false);
							},
							(reason) => {
								setError(String((reason && reason.message) || reason));
								setBusy(false);
							},
						);
					},
					(reason) => {
						setError(String((reason && reason.message) || reason));
						setBusy(false);
					},
				);
			};

			/** Reveal a staged run directory in the OS file manager. */
			const openDirectory = (row, directory) => {
				if (typeof directory !== "string" || directory.length === 0) {
					setOpenNotice({ row: row, ok: false, text: "这条记录没有目录路径。" });
					return;
				}
				setOpenNotice({ row: row, ok: true, text: "正在请求系统打开：" + directory });
				callApi("/open-directory", { path: directory }).then(
					(result) => {
						if (result.payload && result.payload.ok === true) {
							setOpenNotice({ row: row, ok: true, text: "已请求系统打开（若窗口没弹出，请看运行 DSH 的终端）：" + directory });
							return;
						}
						// A non-JSON answer means the running HOST half has no such route: the client
						// half can arrive with a page refresh, the host half only with a restart, so
						// this mismatch is worth naming instead of showing a bare status code.
						if (result.payload === null) {
							setOpenNotice({
								row: row,
								ok: false,
								text: "宿主半体还是旧版本，没有 /open-directory 路由；重启 DSH 后「打开目录」才可用（HTTP " + text(result.status) + "）。",
							});
							return;
						}
						setOpenNotice({ row: row, ok: false, text: result.payload.error ? text(result.payload.error) : "无法打开目录（HTTP " + text(result.status) + "）" });
					},
					(reason) => setOpenNotice({ row: row, ok: false, text: String((reason && reason.message) || reason) }),
				);
			};

			/**
			 * Delete the staged runs whose source is no longer a registered workspace.
			 *
			 * The host recomputes which runs those are (and refuses to delete anything else), so the
			 * button cannot delete a run that is still usable.
			 */
			const pruneRuns = () => {
				setBusy(true);
				callApi("/prune-runs", {}).then(
					(result) => {
						const payload = result.payload;
						if (payload && payload.ok === true) {
							const removed = Array.isArray(payload.removed) ? payload.removed : [];
							setOpenNotice({
								row: "runs",
								ok: true,
								text: removed.length === 0 ? "没有可清理的暂存记录。" : "已清理 " + text(removed.length) + " 条无法使用的暂存记录。",
							});
							refresh();
						} else if (payload === null) {
							setOpenNotice({ row: "runs", ok: false, text: "宿主半体还是旧版本，没有 /prune-runs 路由；重启 DSH 后才可用（HTTP " + text(result.status) + "）。" });
						} else {
							setOpenNotice({ row: "runs", ok: false, text: payload && payload.error ? text(payload.error) : "清理失败（HTTP " + text(result.status) + "）" });
						}
						setBusy(false);
					},
					(reason) => {
						setOpenNotice({ row: "runs", ok: false, text: String((reason && reason.message) || reason) });
						setBusy(false);
					},
				);
			};

			/** The notice for one row, rendered where the user just clicked. */
			const noticeFor = (row) =>
				openNotice !== null && openNotice.row === row
					? react.createElement(
							"span",
							{ className: openNotice.ok ? "dwsm-good" : "dwsm-bad" },
							(openNotice.ok ? "[√] " : "[×] ") + openNotice.text,
						)
					: null;

			const refresh = () => {
				setBusy(true);
				setError(null);
				callApi("/state").then(
					(result) => {
						if (result.payload && result.payload.ok === true) {
							setState(result.payload);
						} else {
							setError(
								result.payload && result.payload.error
									? text(result.payload.error)
									: "无法读取 DSH 状态（HTTP " + text(result.status) + "）",
							);
						}
						setBusy(false);
					},
					(reason) => {
						setError(String((reason && reason.message) || reason));
						setBusy(false);
					},
				);
			};

			react.useEffect(() => {
				refresh();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			// The conversation-header entry carries the Session id. Resolve it to that
			// Session's own workspace path so the user never retypes the path they are
			// already looking at. Only the dialog instance preselects; the Settings page
			// is left alone so opening it never silently rewrites its form.
			react.useEffect(() => {
				const sessionId = dialog.sessionId;
				if (!prefillFromSession || sessionId === null || prefilled === sessionId) return;
				setPrefilled(sessionId);
				callApi("/session", { sessionId: sessionId }).then(
					(result) => {
						const payload = result.payload;
						if (payload && payload.ok === true && typeof payload.cwd === "string" && payload.cwd.length > 0) {
							setFrom(payload.cwd);
							setPlan(null);
							setVerify(null);
							setError(null);
						} else {
							setError(
								"无法确定该会话所属的工作区路径" +
									(payload && payload.error ? "：" + text(payload.error) : "，请手动选择或填写。"),
							);
						}
					},
					(reason) => {
						setError("无法确定该会话所属的工作区路径：" + String((reason && reason.message) || reason));
					},
				);
			}, [dialog.sessionId, prefillFromSession, prefilled]);

			const makePlan = () => {
				if (from.trim().length === 0 || to.trim().length === 0) {
					setError("请先填写「从」和「到」两个路径。");
					return;
				}
				setBusy(true);
				setError(null);
				setPlan(null);
				setVerify(null);
				setLiveInspect(null);
				setLiveResult(null);
				/**
				 * The same check runs first here as in the live flow — but narrowed to what holds
				 * with DSH stopped (`projectOnly`): the source path and the destination directory.
				 * A plan is a stop-DSH fallback, so a live-only precondition (an unavailable
				 * registry, a running session) must not be able to block it; a destination that is
				 * not empty must, and it does.
				 */
				callApi("/live-inspect", { from: from.trim(), to: to.trim(), moveProject: moveFiles, projectOnly: true }).then(
					(checked) => {
						const verdict = checked.payload;
						if (!(verdict && typeof verdict.ok === "boolean")) {
							setError(verdict && verdict.error ? text(verdict.error) : "检查失败（HTTP " + text(checked.status) + "）");
							setBusy(false);
							return;
						}
						setLiveInspect(verdict);
						if (verdict.ok !== true) {
							setBusy(false);
							return;
						}
						// The「方式」slider applies to the manual flow too: without this the staged script
						// would leave the project where it is and the slider would lie.
						callApi("/plan", { from: from.trim(), to: to.trim(), project: moveFiles ? "move" : "keep" }).then(
							(result) => {
								const payload = result.payload;
								if (payload && payload.json) {
									setPlan(payload.json);
								} else {
									setError(payload && payload.error ? text(payload.error) : payload && payload.stderr ? text(payload.stderr) : "生成计划失败（HTTP " + text(result.status) + "）");
								}
								setBusy(false);
							},
							(reason) => {
								setError(String((reason && reason.message) || reason));
								setBusy(false);
							},
						);
					},
					(reason) => {
						setError(String((reason && reason.message) || reason));
						setBusy(false);
					},
				);
			};

			const runVerify = (planFile) => {
				setBusy(true);
				setError(null);
				setVerify(null);
				callApi("/verify", { planFile: planFile }).then(
					(result) => {
						const outcome = result.payload && result.payload.json ? result.payload.json : { ok: false, failures: [text(result.payload && result.payload.error) || "verify 失败"] };
						setVerify(outcome);
						setBusy(false);
					},
					(reason) => {
						setError(String((reason && reason.message) || reason));
						setBusy(false);
					},
				);
			};

			const children = [];

			children.push(
				react.createElement(
					"div",
					{ key: "head" },
					react.createElement("div", { className: "dwsm-h1" }, "工作区迁移 / Workspace migration"),
					react.createElement(
						"div",
						{ className: "dwsm-sub" },
						"把工作区搬到新路径：项目目录、注册记录和全部会话一起迁走，正在对话的会话也不会中断。",
					),
				),
			);

			if (error !== null) {
				children.push(react.createElement(CodeLine, { key: "err" }, react.createElement("span", { className: "dwsm-bad" }, error)));
			}

			// workspace picker
			const workspaces = state && Array.isArray(state.workspaces) ? state.workspaces : [];
			children.push(
				react.createElement(
					"div",
					{ className: "dwsm-card", key: "pick" },
					react.createElement(
						"div",
						{ className: "dwsm-row" },
						react.createElement("span", { className: "dwsm-label" }, "工作区"),
						react.createElement(
							"select",
							{
								className: "dwsm-select",
								// The picker must reflect the workspace currently in「从」, otherwise a
								// "controlled" select with a constant value snaps back to the placeholder
								// option no matter what the user picked.
								value: workspaces.reduce(
									(acc, workspace) => (acc === "" && samePathText(workspace.path, from) ? workspace.path : acc),
									"",
								),
								onChange: (event) => {
									const picked = event.target.value;
									if (picked.length > 0) {
										setFrom(picked);
										setPlan(null);
										setVerify(null);
									}
								},
							},
							[react.createElement("option", { key: "", value: "" }, "— 选择一个已注册工作区，自动填入下方「从」—")].concat(
								workspaces.map((workspace) =>
									react.createElement(
										"option",
										{ key: workspace.id, value: workspace.path },
										text(workspace.title) +
											"  （" +
											text(workspace.sessionIds.length) +
											" 个会话 · " +
											(workspace.pathState === "directory" ? "路径正常" : "路径不存在") +
											"）",
									),
								),
							),
						),
					),
					react.createElement(
						"div",
						{ className: "dwsm-row" },
						react.createElement("span", { className: "dwsm-label" }, "从"),
						react.createElement("input", {
							className: "dwsm-input",
							value: from,
							spellCheck: false,
							// The source must be a registered workspace, so it is chosen from the picker
							// above rather than typed: a typo here used to read as "nothing to migrate".
							readOnly: true,
							title: "由上面的工作区下拉框选择",
							placeholder: "在上面的下拉框里选择工作区",
						}),
					),
					react.createElement(
						"div",
						{ className: "dwsm-row" },
						react.createElement("span", { className: "dwsm-label" }, "到"),
						react.createElement("input", {
							className: "dwsm-input",
							value: to,
							spellCheck: false,
							placeholder: "迁移到的新路径",
							onChange: (event) => editTo(event.target.value),
						}),
					),
					// 「连同文件迁移」/「仅修改目录」: a slider, because the old checkbox asked the user to
					// know whether the destination directory exists — and phrased the choice as an extra.
					react.createElement(
						"div",
						{ className: "dwsm-row" },
						react.createElement("span", { className: "dwsm-label" }, "方式"),
						react.createElement(
							"div",
							{ className: "dwsm-modes" },
							react.createElement(
								"button",
								{
									type: "button",
									className: "dwsm-mode" + (moveFiles ? " dwsm-mode-on" : ""),
									onClick: () => {
										setMoveFiles(true);
										setLiveInspect(null);
										setLiveResult(null);
										setPlan(null);
									},
								},
								"连同文件迁移",
							),
							react.createElement(
								"button",
								{
									type: "button",
									className: "dwsm-mode" + (moveFiles ? "" : " dwsm-mode-on"),
									onClick: () => {
										setMoveFiles(false);
										setLiveInspect(null);
										setLiveResult(null);
										setPlan(null);
									},
								},
								"仅修改目录",
							),
						),
					),
					react.createElement(
						"div",
						{ className: "dwsm-row" },
						react.createElement(
							"label",
							{ className: "dwsm-check" },
							react.createElement("input", {
								type: "checkbox",
								checked: manual,
								onChange: (event) => {
									setManual(event.target.checked);
									setLiveInspect(null);
									setLiveResult(null);
									setPlan(null);
								},
							}),
							"手动迁移",
						),
						react.createElement(
							"button",
							{
								type: "button",
								className: "dwsm-i",
								title: "手动迁移怎么用",
								"aria-label": "手动迁移怎么用",
								onClick: () => toggleRow("manualHint"),
							},
							"i",
						),
					),
					expanded.manualHint === true
						? react.createElement(
								"div",
								{ className: "dwsm-hint" },
								"将生成计划，根据计划指引自行执行脚本，迁移后需重启 DSH 才能生效。",
							)
						: null,
					react.createElement(
						"div",
						{ className: "dwsm-row" },
						react.createElement(
							"button",
							{
								type: "button",
								className: "dwsm-btn dwsm-btn-primary",
								disabled: busy,
								onClick: manual ? makePlan : startMigration,
							},
							busy ? "处理中…" : manual ? "生成计划" : "开始迁移",
						),
						react.createElement("button", { type: "button", className: "dwsm-btn", disabled: busy, onClick: refresh }, "刷新状态"),
					),
				),
			);

			// Every result is one collapsed summary row; open it for the detail.
			if (liveInspect !== null) {
				const passed = liveInspect.ok === true;
				const lines = [];
				lines.push(passed ? "[√] 检查通过：可以迁移，正在继续。" : "[×] 检查未通过，没有执行任何改动。");
				for (const blocker of liveInspect.blockers || []) lines.push("[×] " + text(blocker));
				for (const note of liveInspect.notes || []) lines.push(marked(note));
				if (liveInspect.project) {
					lines.push(
						"项目目录: " +
							(liveInspect.project.willMove ? "将被一起搬迁" : "保持原位") +
							"（源 " + (liveInspect.project.sourceExists ? "存在" : "不存在") +
							"，目标 " + (liveInspect.project.destinationExists ? "已存在" : (liveInspect.project.createDestination ? "不存在，将自动创建" : "不存在")) + "）",
					);
				}
				lines.push("待迁移会话: " + text((liveInspect.sessionIds || []).length) + " 个");
				children.push(
					react.createElement(
						"div",
						{ key: "check" },
						react.createElement(
							Disclosure,
							{
								title: "Check",
								chip: { label: passed ? "通过" : "失败", className: passed ? "dwsm-chip-ok" : "dwsm-chip-bad" },
								open: rowOpen("check", liveInspect.ok !== true),
								onToggle: () => toggleRow("check"),
							},
							react.createElement(CodeLine, null, lines.join("\n")),
						),
					),
				);
			}

			if (liveResult !== null) {
				const lines = [];
				const done = liveResult.ok === true;
				if (done) {
					lines.push("[√] 迁移完成（全程未关闭 DSH）");
					lines.push("会话: " + text(liveResult.movedCount) + " 个");
					lines.push(text(liveResult.from) + "  ->  " + text(liveResult.to));
					lines.push("工作区: " + (liveResult.workspaceCreated ? "已新建" : "复用已有的") + " " + text(liveResult.workspaceTitle));
					lines.push("项目目录: " + (liveResult.projectMoved ? "已一起搬迁" : "保持原位") + (liveResult.destinationCreated ? "（目标目录已创建）" : ""));
					for (const id of liveResult.sessionIds || []) lines.push("   - " + text(id));
				} else {
					lines.push("[×] 迁移失败（阶段：" + text(liveResult.stage) + "）");
					for (const blocker of liveResult.blockers || []) lines.push("[×] " + text(blocker));
					if (liveResult.rollback) {
						lines.push((liveResult.rollback.filesRestored === true ? "[√]" : "[×]") + " 文件已还原: " + (liveResult.rollback.filesRestored === true ? "是" : "否"));
						for (const err of liveResult.rollback.memoryErrors || []) lines.push("[×] 内存回滚错误: " + text(err));
						for (const err of liveResult.rollback.undoErrors || []) lines.push("[×] 撤销错误: " + text(err));
					}
				}
				for (const note of liveResult.notes || []) lines.push(marked(note));
				children.push(
					react.createElement(
						"div",
						{ key: "migrate" },
						react.createElement(
							Disclosure,
							{
								title: "Migrate",
								chip: { label: done ? "成功" : "失败", className: done ? "dwsm-chip-ok" : "dwsm-chip-bad" },
								open: rowOpen("migrate", liveResult.ok !== true),
								onToggle: () => toggleRow("migrate"),
							},
							react.createElement(CodeLine, null, lines.join("\n")),
						),
					),
				);
			}

			// plan result
			if (plan !== null) {
				const lines = [];
				const ready = plan.ok === true;
				lines.push(ready ? "[√] 结论：可以执行（READY）" : "[×] 结论：被阻止（BLOCKED）");
				lines.push("projectKey: " + text(plan.oldKey));
				lines.push("         -> " + text(plan.newKey));
				lines.push("待迁移会话: " + text(plan.sessions ? plan.sessions.toMigrate.length : "?") + " 个（跳过 " + text(plan.sessions ? plan.sessions.foreign.length : "?") + "，已在目标 " + text(plan.sessions ? plan.sessions.alreadyAtNew.length : "?") + "）");
				lines.push("元数据补丁: " + text(plan.metadata ? plan.metadata.patches.length : "?") + " 处");
				lines.push("项目目录动作: " + text(plan.project ? plan.project.action : "?"));
				lines.push("DSH 是否在运行: " + (plan.running && plan.running.dshProcesses && plan.running.dshProcesses.length > 0 ? "是 —— 执行前必须先完全退出 DSH" : "否"));
				for (const warning of plan.warnings || []) lines.push("[!] " + text(warning));
				for (const err of plan.errors || []) lines.push("[×] " + text(err));

				const planChildren = [react.createElement(CodeLine, { key: "kv" }, lines.join("\n"))];

				if (plan.stage) {
					planChildren.push(
						react.createElement(
							"div",
							{ key: "stage", className: "dwsm-list" },
							react.createElement("div", { className: "dwsm-sub" }, "已暂存运行目录"),
							react.createElement("div", { className: "dwsm-mono" }, text(plan.stage.dir)),
							react.createElement("div", { className: "dwsm-sub" }, "退出 DSH 后依次执行："),
							react.createElement(CodeLine, null, "1)  " + text(plan.stage.applyCmd)),
							react.createElement(CodeLine, null, "2)  " + text(plan.stage.verifyCmd) + "   （必须全 PASS）"),
							// Rollback is not a third step of the happy path: it is the way out when
							// step 1 or 2 went wrong, so it gets its own subheading and its own line.
							react.createElement("div", { className: "dwsm-sub" }, "若遇到错误，可以回滚："),
							react.createElement(CodeLine, null, "3)  " + text(plan.stage.rollbackCmd)),
						),
					);
				}
				children.push(
					react.createElement(
						"div",
						{ key: "plan" },
						react.createElement(
							Disclosure,
							{
								title: "Plan",
								chip: { label: ready ? "可执行" : "被阻止", className: ready ? "dwsm-chip-ok" : "dwsm-chip-bad" },
								open: expanded.plan === true,
								onToggle: () => toggleRow("plan"),
								actions:
									plan.stage && typeof plan.stage.dir === "string"
										? react.createElement(
												"button",
												{
													type: "button",
													className: "dwsm-btn",
													onClick: (event) => {
														event.stopPropagation();
														openDirectory("plan", plan.stage.dir);
													},
												},
												"打开目录",
											)
										: null,
								banner: noticeFor("plan"),
							},
							planChildren,
						),
					),
				);
			}

			if (verify !== null) {
				const lines = [];
				const ok = verify.ok === true;
				for (const check of verify.checks || []) lines.push((check.ok ? "[√]" : "[×]") + " " + text(check.name) + "  " + text(check.detail));
				for (const note of verify.notes || []) lines.push(marked(note));
				lines.push((ok ? "[√]" : "[×]") + " 结论: " + (ok ? "ALL CHECKS PASS" : text((verify.failures || []).length) + " 项失败"));
				children.push(
					react.createElement(
						"div",
						{ key: "verify" },
						react.createElement(
							Disclosure,
							{
								title: "Verify",
								chip: { label: ok ? "全部通过" : text((verify.failures || []).length) + " 项失败", className: ok ? "dwsm-chip-ok" : "dwsm-chip-bad" },
								open: rowOpen("verify", verify.ok !== true),
								onToggle: () => toggleRow("verify"),
							},
							react.createElement("div", { className: "dwsm-sub" }, "检测到当前状态：" + text(verify.detectedState)),
							react.createElement(CodeLine, null, lines.join("\n")),
						),
					),
				);
			}

			// staged manual runs, collapsed into one row
			if (state && Array.isArray(state.runs)) {
				const runs = state.runs.slice().reverse();
				const unusable = runs.filter((run) => run.usable === false);
				const rows = [];
				if (runs.length === 0) {
					rows.push(react.createElement("div", { className: "dwsm-sub", key: "none" }, "还没有暂存记录。勾选「手动迁移」后点「生成计划」。"));
				}
				for (const run of runs) {
					// One line per staged run: where it goes, and the way into its directory. The
					// runner inside is always 1-apply-migration.cmd, so the path adds nothing the
					// button does not already give; the verify step is the second script, run after
					// DSH is down, so a button for it here cannot be used at that point anyway.
					//
					// A run whose source is no longer a registered workspace can never be applied
					// (the workspace it would migrate is gone), so it is labelled instead of silently
					// sitting there looking actionable.
					rows.push(
						react.createElement(
							"div",
							{ className: "dwsm-item", key: run.dir },
							react.createElement("div", { className: "dwsm-mono" }, text(run.from) + "  ->  " + text(run.to)),
							react.createElement(
								"div",
								{ className: "dwsm-row" },
								run.usable === false
									? react.createElement("span", { className: "dwsm-chip dwsm-chip-warn" }, "无法使用")
									: null,
								react.createElement(
									"button",
									{
										type: "button",
										className: "dwsm-btn",
										disabled: busy,
										onClick: () => openDirectory("runs", run.dir),
									},
									"打开目录",
								),
							),
						),
					);
				}
				const runActions = [];
				runActions.push(
					react.createElement(
						"button",
						{
							key: "i",
							type: "button",
							className: "dwsm-i",
							title: "怎么用",
							"aria-label": "怎么用",
							onClick: (event) => {
								event.stopPropagation();
								toggleRow("hint");
							},
						},
						"i",
					),
				);
				if (unusable.length > 0) {
					runActions.push(
						react.createElement(
							"button",
							{
								key: "prune",
								type: "button",
								className: "dwsm-btn",
								disabled: busy,
								onClick: (event) => {
									event.stopPropagation();
									pruneRuns();
								},
							},
							"清理无法使用的暂存",
						),
					);
				}
				children.push(
					react.createElement(
						"div",
						{ key: "runs" },
						react.createElement(
							Disclosure,
							{
								title: "暂存的手动迁移",
								chip: { label: text(runs.length) + " 个", className: "dwsm-chip-info" },
								open: expanded.runs === true,
								onToggle: () => toggleRow("runs"),
								// The rows are bare paths now, so the steps live behind this 「i」.
								actions: runActions,
								hint:
									expanded.hint === true
										? "用法：先点「打开目录」，然后完全退出 DSH，再按顺序手动执行目录里的\n" +
											"  1-apply-migration.cmd   （执行迁移）\n" +
											"  2-verify.cmd            （校验，必须全 PASS）\n" +
											"若中间报错，执行 3-rollback.cmd 回滚。\n" +
											"迁移完成后需重启 DSH 才能生效。"
										: null,
								banner: noticeFor("runs"),
							},
							rows,
						),
					),
				);
			}

			return react.createElement("div", { className: "dwsm-root" }, children);
		}
		//#endregion

		//#region entries
		/**
		 * Sidebar-foot entry.
		 *
		 * The seat has exactly one owner prop — `wide`, false when the sidebar is collapsed into its
		 * 56px rail (read from the live Slot catalog: `SidebarFooterActionOwnerProps { wide: boolean }`).
		 * In the rail the owner centers its children and a two-character label would wrap vertically,
		 * so the label is dropped and only the glyph remains, in a square button. Defence in depth:
		 * an owner that passes nothing (a build older than the prop) keeps the labelled form.
		 */
		function SidebarEntry(props) {
			const wide = !props || props.wide !== false;
			return react.createElement(
				"button",
				{
					type: "button",
					className: wide ? "dwsm-entry" : "dwsm-entry dwsm-entry-rail",
					title: "工作区迁移",
					"aria-label": "工作区迁移",
					onClick: () => openDialog(null),
				},
				react.createElement("span", { className: "dwsm-entry-icon", "aria-hidden": "true" }, "⇄"),
				wide ? react.createElement("span", { className: "dwsm-entry-label" }, "迁移") : null,
			);
		}

		/**
		 * Conversation-header entry. This seat is `session`-scoped and passes
		 * `sessionId` among its standard props, so the dialog can preselect the
		 * workspace the user is already looking at.
		 */
		function HeaderEntry(props) {
			const sessionId = props && typeof props.sessionId === "string" ? props.sessionId : null;
			return react.createElement(
				"button",
				{
					type: "button",
					className: "dwsm-btn",
					title: "迁移这个会话所在的工作区路径",
					onClick: () => openDialog(sessionId),
				},
				"迁移工作区",
			);
		}

		/** Settings-section wrapper: it must not steal the dialog's session preselect. */
		function SettingsPanel(props) {
			return react.createElement(Panel, Object.assign({}, props, { prefillFromSession: false }));
		}

		function Dialog() {
			const dialog = useDialog();
			if (!dialog.open) return null;
			return react.createElement(
				"div",
				{
					className: "dwsm-overlay",
					role: "dialog",
					"aria-modal": "true",
					onClick: (event) => {
						if (event.target === event.currentTarget) closeDialog();
					},
				},
				react.createElement(
					"div",
					{ className: "dwsm-dialog" },
					react.createElement(Panel, { prefillFromSession: true }),
					react.createElement(
						"div",
						{ className: "dwsm-foot", style: { marginTop: "12px" } },
						react.createElement("button", { type: "button", className: "dwsm-btn", onClick: () => closeDialog() }, "关闭"),
					),
				),
			);
		}
		//#endregion

		//#region plugin
		/** Required client services (cordis fiber inject). */
		const inject = ["slots"];

		/**
		 * Every seat this plugin contributes. All four are additive (`replaceRisk:
		 * none`): none of them shadows shipped UI, and `sidebar.workspaces` — the
		 * session list itself — is deliberately absent, because that `single` slot
		 * would replace the whole shipped sidebar.
		 */
		const ENTRIES = [
			{ slot: "sidebar.footer.action", options: { id: "workspace-migrate", order: 100, label: () => "工作区迁移" }, component: SidebarEntry },
			{ slot: "conversation.session.header.actions", options: { id: "workspace-migrate", order: 100, label: () => "迁移工作区" }, component: HeaderEntry },
			{ slot: "settings.section", options: { id: "workspace-migrate", order: 45, label: () => "工作区迁移" }, component: SettingsPanel },
			{ slot: "shell.overlay", options: { id: "workspace-migrate-dialog", order: 50 }, component: Dialog },
		];

		/**
		 * Mount the entry points and the dialog. Every registration is additive and
		 * owned by this plugin's fiber, so disabling the plugin removes all of them.
		 * A seat that cannot be registered is logged and skipped rather than costing
		 * the other three.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) {
				console.error("[dsh-workspace-migrate] the slots service is unavailable; no UI was registered");
				return;
			}
			for (const entry of ENTRIES) {
				try {
					ctx.effect(
						() =>
							slots.inject(entry.slot, () =>
								slots.register(Object.assign({ name: entry.slot }, entry.options), entry.component),
							),
						"workspace-migrate: " + entry.slot,
					);
				} catch (error) {
					console.error("[dsh-workspace-migrate] could not register into " + entry.slot + ":", error);
				}
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
