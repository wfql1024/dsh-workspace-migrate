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
			".dwsm-modes{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:16px;overflow:hidden;}",
			".dwsm-mode{padding:5px 12px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:12px;font-family:inherit;}",
			".dwsm-mode-on{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,inherit);font-weight:500;}",
			".dwsm-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;}",
			".dwsm-btn-danger{border-color:var(--dsw-alias-state-error-primary,#e5534b);color:var(--dsw-alias-state-error-primary,#e5534b);}",
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
			/** "live" (no restart, preferred) or "plan" (the stop-DSH flow). */
			const [mode, setMode] = react.useState("live");
			const [moveProject, setMoveProject] = react.useState(false);
			const [liveInspect, setLiveInspect] = react.useState(null);
			const [liveResult, setLiveResult] = react.useState(null);

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

			const inspectLive = () => {
				if (from.trim().length === 0 || to.trim().length === 0) {
					setError("请先填写「从」和「到」两个路径。");
					return;
				}
				setBusy(true);
				setError(null);
				setLiveInspect(null);
				setLiveResult(null);
				setPlan(null);
				callApi("/live-inspect", { from: from.trim(), to: to.trim(), moveProject: moveProject }).then(
					(result) => {
						const payload = result.payload;
						if (payload && typeof payload.ok === "boolean") setLiveInspect(payload);
						else setError(payload && payload.error ? text(payload.error) : "预检失败（HTTP " + text(result.status) + "）");
						setBusy(false);
					},
					(reason) => {
						setError(String((reason && reason.message) || reason));
						setBusy(false);
					},
				);
			};

			const runLiveMove = () => {
				setBusy(true);
				setError(null);
				setLiveResult(null);
				callApi("/live-move", { from: from.trim(), to: to.trim(), moveProject: moveProject, confirm: true }).then(
					(result) => {
						const payload = result.payload;
						if (payload && typeof payload.ok === "boolean") {
							setLiveResult(payload);
							if (payload.ok === true) refresh();
						} else {
							setError(payload && payload.error ? text(payload.error) : "迁移失败（HTTP " + text(result.status) + "）");
						}
						setBusy(false);
					},
					(reason) => {
						setError(String((reason && reason.message) || reason));
						setBusy(false);
					},
				);
			};

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
				callApi("/plan", { from: from.trim(), to: to.trim() }).then(
					(result) => {
						const payload = result.payload;
						if (payload && payload.ok === true && payload.json) {
							setPlan(payload.json);
						} else if (payload && payload.json) {
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
			};

			const runVerify = (planFile) => {
				setBusy(true);
				setError(null);
				setVerify(null);
				callApi("/verify", { planFile: planFile }).then(
					(result) => {
						setVerify(result.payload && result.payload.json ? result.payload.json : { ok: false, failures: [text(result.payload && result.payload.error) || "verify 失败"] });
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
						"改项目路径 + 搬会话日志 + 同步工作区注册表与投影缓存。迁移必须在本机 DSH 完全退出后执行，本页只能做只读计划。",
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
							placeholder: "当前工作区路径",
							onChange: (event) => editFrom(event.target.value),
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
									className: "dwsm-mode" + (mode === "live" ? " dwsm-mode-on" : ""),
									onClick: () => setMode("live"),
								},
								"不停机迁移（推荐）",
							),
							react.createElement(
								"button",
								{
									type: "button",
									className: "dwsm-mode" + (mode === "plan" ? " dwsm-mode-on" : ""),
									onClick: () => setMode("plan"),
								},
								"停机计划",
							),
						),
					),
					mode === "live"
						? react.createElement(
								"label",
								{ className: "dwsm-check" },
								react.createElement("input", {
									type: "checkbox",
									checked: moveProject,
									onChange: (event) => {
										setMoveProject(event.target.checked);
										setLiveInspect(null);
										setLiveResult(null);
									},
								}),
								"目标目录还不存在，帮我把项目目录一起搬过去",
							)
						: null,
					react.createElement(
						"div",
						{ className: "dwsm-row" },
						mode === "live"
							? react.createElement(
									"button",
									{ type: "button", className: "dwsm-btn dwsm-btn-primary", disabled: busy, onClick: inspectLive },
									busy ? "处理中…" : "预检（只读，不改任何东西）",
								)
							: react.createElement(
									"button",
									{ type: "button", className: "dwsm-btn dwsm-btn-primary", disabled: busy, onClick: makePlan },
									busy ? "处理中…" : "生成迁移计划（只读 dry-run）",
								),
						mode === "live" && liveInspect !== null && liveInspect.ok === true
							? react.createElement(
									"button",
									{ type: "button", className: "dwsm-btn dwsm-btn-danger", disabled: busy, onClick: runLiveMove },
									"执行不停机迁移",
								)
							: null,
						react.createElement("button", { type: "button", className: "dwsm-btn", disabled: busy, onClick: refresh }, "刷新状态"),
					),
				),
			);

			// live verdict / result
			if (liveInspect !== null) {
				const lines = [];
				lines.push(liveInspect.ok === true ? "预检结论：可以迁移（不需要关 DSH）" : "预检结论：会被拒绝");
				for (const blocker of liveInspect.blockers || []) lines.push("阻止: " + text(blocker));
				for (const note of liveInspect.notes || []) lines.push("提示: " + text(note));
				if (liveInspect.project) {
					lines.push(
						"项目目录: " +
							(liveInspect.project.willMove ? "将被一起搬迁" : "保持原位") +
							"（源 " + (liveInspect.project.sourceExists ? "存在" : "不存在") +
							"，目标 " + (liveInspect.project.destinationExists ? "已存在" : "可写") + "）",
					);
				}
				lines.push("待迁移会话: " + text((liveInspect.sessionIds || []).length) + " 个");
				children.push(react.createElement("div", { className: "dwsm-card", key: "liveinspect" }, react.createElement(CodeLine, null, lines.join("\n"))));
			}

			if (liveResult !== null) {
				const lines = [];
				if (liveResult.ok === true) {
					lines.push("迁移完成（全程未关闭 DSH）");
					lines.push("会话: " + text(liveResult.movedCount) + " 个");
					lines.push(text(liveResult.from) + "  ->  " + text(liveResult.to));
					lines.push("工作区: " + (liveResult.workspaceCreated ? "已新建" : "复用已有的") + " " + text(liveResult.workspaceTitle));
					lines.push("项目目录: " + (liveResult.projectMoved ? "已一起搬迁" : "保持原位"));
					for (const id of liveResult.sessionIds || []) lines.push("   - " + text(id));
				} else {
					lines.push("迁移失败（阶段：" + text(liveResult.stage) + "）");
					for (const blocker of liveResult.blockers || []) lines.push("阻止: " + text(blocker));
					if (liveResult.rollback) {
						lines.push("文件已还原: " + (liveResult.rollback.filesRestored === true ? "是" : "否"));
						for (const err of liveResult.rollback.memoryErrors || []) lines.push("内存回滚错误: " + text(err));
						for (const err of liveResult.rollback.undoErrors || []) lines.push("撤销错误: " + text(err));
					}
				}
				for (const note of liveResult.notes || []) lines.push("提示: " + text(note));
				children.push(
					react.createElement(
						"div",
						{ className: "dwsm-card", key: "liveresult" },
						react.createElement(CodeLine, null, lines.join("\n")),
					),
				);
			}

			// plan result
			if (plan !== null) {
				const lines = [];
				lines.push(plan.ok === true ? "结论：可以执行（READY）" : "结论：被阻止（BLOCKED）");
				lines.push("projectKey: " + text(plan.oldKey));
				lines.push("         -> " + text(plan.newKey));
				lines.push("待迁移会话: " + text(plan.sessions ? plan.sessions.toMigrate.length : "?") + " 个（跳过 " + text(plan.sessions ? plan.sessions.foreign.length : "?") + "，已在目标 " + text(plan.sessions ? plan.sessions.alreadyAtNew.length : "?") + "）");
				lines.push("元数据补丁: " + text(plan.metadata ? plan.metadata.patches.length : "?") + " 处");
				lines.push("项目目录动作: " + text(plan.project ? plan.project.action : "?"));
				lines.push("DSH 是否在运行: " + (plan.running && plan.running.dshProcesses && plan.running.dshProcesses.length > 0 ? "是 —— 执行前必须先完全退出 DSH" : "否"));
				for (const warning of plan.warnings || []) lines.push("警告: " + text(warning));
				for (const err of plan.errors || []) lines.push("错误: " + text(err));

				const planChildren = [react.createElement(CodeLine, { key: "kv" }, lines.join("\n"))];

				if (plan.stage) {
					planChildren.push(
						react.createElement(
							"div",
							{ key: "stage", className: "dwsm-list" },
							react.createElement("div", { className: "dwsm-sub" }, "已暂存运行目录"),
							react.createElement("div", { className: "dwsm-mono" }, text(plan.stage.dir)),
							react.createElement(
								"div",
								{ className: "dwsm-sub" },
								"退出 DSH 后依次执行：",
							),
							react.createElement(CodeLine, null, "1)  " + text(plan.stage.applyCmd)),
							react.createElement(CodeLine, null, "2)  " + text(plan.stage.verifyCmd) + "   （必须全 PASS）"),
							react.createElement(CodeLine, null, "3)  回滚： " + text(plan.stage.rollbackCmd)),
							react.createElement(
								"div",
								{ className: "dwsm-row" },
								react.createElement(
									"button",
									{
										type: "button",
										className: "dwsm-btn",
										disabled: busy,
										onClick: () => runVerify(plan.stage.planFile),
									},
									"立即只读校验（verify）",
								),
							),
						),
					);
				}
				children.push(react.createElement("div", { className: "dwsm-card", key: "plan" }, planChildren));
			}

			if (verify !== null) {
				const lines = [];
				for (const check of verify.checks || []) lines.push((check.ok ? "PASS  " : "FAIL  ") + text(check.name) + "  " + text(check.detail));
				for (const note of verify.notes || []) lines.push("note  " + text(note));
				lines.push("结论: " + (verify.ok ? "ALL CHECKS PASS" : text((verify.failures || []).length) + " 项失败"));
				children.push(
					react.createElement(
						"div",
						{ className: "dwsm-card", key: "verify" },
						react.createElement("div", { className: "dwsm-sub" }, "校验结果（检测到当前状态：" + text(verify.detectedState) + "）"),
						react.createElement(CodeLine, null, lines.join("\n")),
					),
				);
			}

			// staged runs
			if (state && Array.isArray(state.runs)) {
				const runs = state.runs.slice().reverse();
				const rows = [
					react.createElement(
						"div",
						{ className: "dwsm-sub", key: "t" },
						"已暂存迁移：" + text(runs.length) + " 个   ·   备份目录：" + text(state.backupRoot || "（默认）"),
					),
				];
				if (runs.length === 0) {
					rows.push(react.createElement("div", { className: "dwsm-sub", key: "none" }, "还没有暂存记录。填好路径后点「生成迁移计划」。"));
				}
				for (const run of runs) {
					rows.push(
						react.createElement(
							"div",
							{ className: "dwsm-item", key: run.dir },
							react.createElement(
								"div",
								null,
								react.createElement("div", { className: "dwsm-mono" }, text(run.from) + "  ->  " + text(run.to)),
								react.createElement(
									"div",
									{ className: "dwsm-sub" },
									"会话 " + text(run.sessions) + "   ·   " + (run.report ? "报告：" + text(run.report.status) : "尚未执行"),
								),
								react.createElement("div", { className: "dwsm-mono" }, "退出 DSH 后执行：" + text(run.applyCmd || "")),
							),
							react.createElement(
								"button",
								{
									type: "button",
									className: "dwsm-btn",
									disabled: busy,
									onClick: () => runVerify(run.planFile),
								},
								"verify",
							),
						),
					);
				}
				children.push(react.createElement("div", { className: "dwsm-card", key: "runs" }, rows));
			}

			if (state) {
				children.push(
					react.createElement(
						"div",
						{ className: "dwsm-sub", key: "env" },
						"DSH_HOME: " + text(state.dshHome) + "   ·   引擎: " + text(state.engine),
					),
				);
			}

			return react.createElement("div", { className: "dwsm-root" }, children);
		}
		//#endregion

		//#region entries
		function SidebarEntry() {
			return react.createElement(
				"button",
				{
					type: "button",
					className: "dwsm-entry",
					title: "工作区迁移",
					"aria-label": "工作区迁移",
					onClick: () => openDialog(null),
				},
				react.createElement("span", { "aria-hidden": "true" }, "⇄"),
				react.createElement("span", null, "迁移"),
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
