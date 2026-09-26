/**
 * Browser-half load test for dsh-workspace-migrate.
 *
 * The client bundle cannot be exercised in a real browser from here, and the
 * page's React is not on disk (the module loader hands `require("react")` the
 * page's own copy), so this harness supplies a minimal React + renderer and
 * reproduces exactly what the vendored cordis Loader does: call
 * `window.__ModuleLoader__.load({ id, factory })`, then invoke the factory with
 * a `require` that resolves the host-provided externals.
 *
 * That catches: a wrong loader call shape, a bad `exports` contract, a throw at
 * module or apply time, a wrong slot registration, a wrong createElement call,
 * and any component that crashes on its first or second render.
 */
import { strict as assert } from 'node:assert'

// ── minimal React ───────────────────────────────────────────────────────────
let cells = []
let cursor = 0
let pendingEffects = []

const react = {
	createElement(type, props, ...children) {
		return { $$element: true, type, props: props ?? {}, children: children.flat(Infinity) }
	},
	useState(initial) {
		const slot = cursor++
		if (cells.length <= slot) cells[slot] = typeof initial === 'function' ? initial() : initial
		const setState = (next) => {
			cells[slot] = typeof next === 'function' ? next(cells[slot]) : next
		}
		return [cells[slot], setState]
	},
	useEffect(effect) {
		pendingEffects.push(effect)
	},
}

function escapeHtml(value) {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render an element tree; function components are invoked, host elements emit tags. */
function render(node) {
	if (node === null || node === undefined || node === false || node === true) return ''
	if (Array.isArray(node)) return node.map(render).join('')
	if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
	if (node.$$element !== true) return ''
	if (typeof node.type === 'function') {
		const props = { ...node.props }
		if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children
		return render(node.type(props))
	}
	const attrs = []
	for (const [key, value] of Object.entries(node.props)) {
		if (key === 'children' || typeof value === 'function' || value === undefined || value === null) continue
		if (key === 'key' || key === 'spellCheck') continue
		attrs.push(` ${key}="${escapeHtml(String(value))}"`)
	}
	const inner = node.children.map(render).join('')
	return `<${node.type}${attrs.join('')}>${inner}</${node.type}>`
}

/** Render one component: render, run its effects, let promises settle, render again. */
async function renderComponent(Component) {
	cursor = 0
	pendingEffects = []
	const first = render(react.createElement(Component, {}))
	const effects = pendingEffects
	pendingEffects = []
	for (const effect of effects) {
		const cleanup = effect()
		if (typeof cleanup === 'function') cleanup()
	}
	for (let i = 0; i < 8; i++) await Promise.resolve()
	cursor = 0
	pendingEffects = []
	const second = render(react.createElement(Component, {}))
	return { first, second }
}

/** Render one component with a clean state store — for components that read module state. */
async function renderFresh(Component, props) {
	cells = []
	cursor = 0
	pendingEffects = []
	const first = render(react.createElement(Component, props ?? {}))
	const effects = pendingEffects
	pendingEffects = []
	for (const effect of effects) {
		const cleanup = effect()
		if (typeof cleanup === 'function') cleanup()
	}
	for (let i = 0; i < 10; i++) await Promise.resolve()
	cursor = 0
	pendingEffects = []
	const second = render(react.createElement(Component, props ?? {}))
	return { first, second }
}

/**
 * Hook slots of `Panel`, in call order — the state store is a plain array, so a test can seed
 * the panel as if a preflight or a migration had just happened. Kept next to the assertion that
 * uses it: if `Panel` gains a hook, this list has to move with it (the test then fails loudly,
 * because the wrong slot shifts every seeded value).
 */
let PanelComponent = null
const PANEL_HOOKS = [
	'dialog', // useDialog()
	'state',
	'error',
	'busy',
	'from',
	'to',
	'plan',
	'verify',
	'prefilled',
	'manual',
	'moveFiles',
	'liveInspect',
	'liveResult',
	'expanded',
	'openNotice',
]

/** Render `Panel` with selected hook slots pre-set. */
async function renderPanelWith(overrides) {
	return render(await panelTreeWith(overrides))
}

/**
 * Seed `Panel` and hand back its element tree (unrendered), so a test can reach a handler rather
 * than only the markup. `render()` drops functions, and the action buttons are the only way to test
 * "the check gates the plan" as behaviour instead of as a shape.
 */
async function panelTreeWith(overrides) {
	// Slot 0 is the dialog state the panel reads (`useDialog()`), the rest mirror Panel's own
	// `useState` defaults. `open: true` keeps every section rendered.
	cells = [{ open: true, sessionId: null }, null, null, false, '', '', null, null, null, false, true, null, null, {}, null]
	for (const [name, value] of Object.entries(overrides)) {
		const slot = PANEL_HOOKS.indexOf(name)
		if (slot === -1) throw new Error(`unknown panel hook: ${name}`)
		cells[slot] = value
	}
	cursor = 0
	pendingEffects = []
	render(react.createElement(PanelComponent, {}))
	const effects = pendingEffects
	pendingEffects = []
	for (const effect of effects) {
		const cleanup = effect()
		if (typeof cleanup === 'function') cleanup()
	}
	for (let i = 0; i < 10; i++) await Promise.resolve()
	cursor = 0
	pendingEffects = []
	return react.createElement(PanelComponent, {})
}

/** Find the props of the first `<button>` whose only child is exactly `label`. */
function findButton(node, label) {
	if (node === null || node === undefined || node === false || node === true) return null
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findButton(child, label)
			if (hit !== null) return hit
		}
		return null
	}
	if (typeof node !== 'object' || node.$$element !== true) return null
	const props = { ...node.props }
	if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children
	if (typeof node.type === 'function') return findButton(node.type(props), label)
	if (node.type === 'button' && props.children === label && typeof props.onClick === 'function') return props
	for (const child of node.children) {
		const hit = findButton(child, label)
		if (hit !== null) return hit
	}
	return null
}

/**
 * Click the action button labelled `label` and return the resulting markup. The hook cursor is
 * reset first because walking the tree invokes `Panel` again — the same order `render()` uses, so
 * the seeded slots line up.
 */
async function clickPanelButton(overrides, label) {
	const tree = await panelTreeWith(overrides)
	cursor = 0
	const button = findButton(tree, label)
	if (button === null) throw new Error(`no button labelled ${label} in the panel`)
	button.onClick()
	for (let i = 0; i < 12; i++) await Promise.resolve()
	cursor = 0
	pendingEffects = []
	return render(react.createElement(PanelComponent, {}))
}

// ── page stubs ──────────────────────────────────────────────────────────────
let capture = null
const headChildren = []
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			capture = definition
		},
	},
}
globalThis.document = {
	querySelector() {
		return null
	},
	createElement() {
		return { dataset: {}, textContent: '' }
	},
	head: {
		appendChild(node) {
			headChildren.push(node)
		},
	},
}
const fetchCalls = []
/**
 * Answers for the two routes the action buttons drive. A test sets them right before clicking, so
 * a click can be observed end to end: which route was asked FIRST and what the panel did with the
 * verdict. Both default to a refusal rather than a fake success — an unset reply must never look
 * like a passing check.
 */
let inspectReply = null
let planReply = null
let moveReply = null
globalThis.fetch = async (url, options) => {
	fetchCalls.push({ url, method: (options && options.method) || 'GET', body: options && options.body })
	if (url.endsWith('/session')) {
		return {
			status: 200,
			json: async () => ({ ok: true, sessionId: 'session-from-props', cwd: 'D:/old/DemoProject', workspaceId: 'w1', workspaceTitle: 'DemoProject', source: 'projcache-session' }),
		}
	}
	if (url.endsWith('/live-inspect')) return { status: 200, json: async () => inspectReply ?? { ok: false, error: 'no inspectReply was set for this test' } }
	if (url.endsWith('/plan')) return { status: 200, json: async () => planReply ?? { ok: false, error: 'no planReply was set for this test' } }
	if (url.endsWith('/live-move')) return { status: 200, json: async () => moveReply ?? { ok: false, error: 'no moveReply was set for this test' } }
	const body = {
		ok: true,
		dshHome: 'C:/Users/probe/.dsh',
		engine: 'C:/pkg/lib/dsh-workspace-migrate.mjs',
		workspaces: [
			{ id: 'w1', title: 'DemoProject', path: 'D:/old/DemoProject', sessionIds: ['session-a', 'session-b'], pathState: 'directory', archived: [] },
			{ id: 'w2', title: '缺失项目', path: 'Z:/gone/Missing', sessionIds: [], pathState: 'missing', archived: [] },
		],
		sessionsRoot: 'C:/Users/probe/.dsh/sessions',
		projectKeys: ['--D-old-DemoProject--'],
		runs: [
			{ dir: 'C:/Users/probe/.dsh/migration-runs/run-1', planFile: 'C:/Users/probe/.dsh/migration-runs/run-1/plan.json', from: 'D:/old/DemoProject', to: 'E:/new/DemoProject', sessions: 2, report: null, applyCmd: 'C:/Users/probe/.dsh/migration-runs/run-1/1-apply-migration.cmd' },
		],
	}
	return { status: 200, json: async () => body }
}

await import('../client.js')

let checks = 0
let failures = 0
const ok = (label, condition, detail = '') => {
	checks++
	if (condition) console.log(`  pass  ${label}`)
	else {
		failures++
		console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`)
	}
}

console.log('\n[1] loader contract')
ok('the bundle calls window.__ModuleLoader__.load', capture !== null)
ok('the loader id matches the package name', capture && capture.id === 'dsh-workspace-migrate', capture && capture.id)
ok('the definition carries a factory function', capture && typeof capture.factory === 'function')

const resolved = []
const fakeRequire = (specifier) => {
	resolved.push(specifier)
	if (specifier === 'react') return react
	if (specifier === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement }
	throw new Error('unexpected external: ' + specifier)
}

const exportsObject = capture.factory(fakeRequire)
ok('only host-provided externals are required', resolved.every((name) => name === 'react' || name === 'react/jsx-runtime'), resolved.join(', '))
ok('the factory returns an exports object', exportsObject !== null && typeof exportsObject === 'object')
ok('exports.apply is a function', typeof exportsObject.apply === 'function')
ok('exports.inject declares the slots service', JSON.stringify(exportsObject.inject) === JSON.stringify(['slots']), JSON.stringify(exportsObject.inject))

console.log('\n[2] mounting through the real apply()')
const registrations = []
const slots = {
	inject(key, callback) {
		const disposer = callback()
		return typeof disposer === 'function' ? disposer : () => {}
	},
	register(options, component) {
		registrations.push({ options, component })
		return () => {}
	},
}
const effectLabels = []
const ctx = {
	get(name) {
		return name === 'slots' ? slots : undefined
	},
	effect(fn, label) {
		effectLabels.push(label)
		const disposer = fn()
		return typeof disposer === 'function' ? disposer : () => {}
	},
}

let mountError = null
try {
	exportsObject.apply(ctx)
} catch (error) {
	mountError = error
}
ok('apply() does not throw', mountError === null, mountError && mountError.message)
ok('all four entries registered', registrations.length === 4, `got ${registrations.length}`)
ok('every registration is owned by a fiber effect', effectLabels.length === 4, `got ${effectLabels.length}`)

const bySlot = {}
for (const registration of registrations) bySlot[registration.options.name] = registration.options
// The component sits on the registration itself; `options` is the slot registration contract.
PanelComponent = registrations.find((registration) => registration.options.name === 'settings.section').component
for (const expected of ['sidebar.footer.action', 'conversation.session.header.actions', 'settings.section', 'shell.overlay']) {
	ok(`registered ${expected}`, bySlot[expected] !== undefined)
}
ok('every registration carries a non-empty string id', registrations.every((r) => typeof r.options.id === 'string' && r.options.id.length > 0))
ok('every registration carries a numeric order', registrations.every((r) => typeof r.options.order === 'number'))
ok('the settings section has a working label thunk', typeof bySlot['settings.section'].label === 'function' && bySlot['settings.section'].label() === '工作区迁移', bySlot['settings.section'].label && bySlot['settings.section'].label())
ok('sidebar.workspaces is never registered (that single slot would shadow the shipped sidebar)', bySlot['sidebar.workspaces'] === undefined)

console.log('\n[3] first and second render of every component')
const rendered = {}
for (const registration of registrations) {
	const label = registration.options.name
	let result = null
	let renderError = null
	try {
		result = await renderComponent(registration.component)
	} catch (error) {
		renderError = error
	}
	ok(`${label} renders`, renderError === null, renderError && renderError.message)
	if (result !== null) {
		rendered[label] = result
		if (label === 'shell.overlay') {
			ok('shell.overlay stays empty while the dialog is closed', result.second === '', `${result.second.length} chars`)
		} else {
			ok(`${label} produced markup`, typeof result.second === 'string' && result.second.length > 0, `${result.second.length} chars`)
			console.log(`        ${result.second.slice(0, 120).replace(/\s+/g, ' ')}${result.second.length > 120 ? ' …' : ''}`)
		}
	}
}

console.log('\n[4] dialog behaviour and data binding')
ok('the dialog renders nothing while closed', rendered['shell.overlay'] && rendered['shell.overlay'].second === '', rendered['shell.overlay'] ? JSON.stringify(rendered['shell.overlay'].second.slice(0, 60)) : 'not rendered')

const panelHtml = rendered['settings.section'] ? rendered['settings.section'].second : ''
ok('the panel fetched /state on mount', fetchCalls.some((entry) => entry.url === '/api/dsh-workspace-migrate/state'), JSON.stringify(fetchCalls))
ok('the panel lists the registered workspaces', panelHtml.includes('DemoProject') && panelHtml.includes('缺失项目'), 'workspace titles missing from markup')
ok('the panel localizes the path state instead of printing raw enum values', panelHtml.includes('路径正常') && panelHtml.includes('路径不存在'), 'path-state labels missing')
// Only the placeholders are checked: the panel legitimately shows the running machine's own
// DSH home further down, which is not a hard-coded author path.
const placeholders = [...panelHtml.matchAll(/placeholder="([^"]*)"/g)].map((match) => match[1])
ok('every placeholder is path-free', placeholders.length > 0 && placeholders.every((value) => !/[A-Za-z]:[\\/]/.test(value)), JSON.stringify(placeholders))
ok('a staged run is one line: where it goes', panelHtml.includes('D:/old/DemoProject') && panelHtml.includes('E:/new/DemoProject'), 'the staged row must show its from -> to line')
ok('the staged runs are one collapsed row, named for the manual flow', panelHtml.includes('暂存的手动迁移') && !panelHtml.includes('已暂存迁移'), 'the runs row must be a single summary row')
ok('the staged run row offers to open its directory', panelHtml.includes('打开目录'), 'missing the open-directory action')
ok(
	'the staged run row drops the detail that cannot be used there',
	!panelHtml.includes('尚未执行') && !panelHtml.includes('退出 DSH 后执行：') && !panelHtml.includes('备份目录：'),
	'a staged row is the path line plus one button',
)
ok('no verify button is offered for a staged run', !/dwsm-item[\s\S]{0,400}?verify/.test(panelHtml), 'verify is the second script, run while DSH is down')
ok('the manual mode is a checkbox, not a mode switch', panelHtml.includes('手动迁移') && !panelHtml.includes('不停机迁移（推荐）'), 'the manual flow must be behind a checkbox')
ok('the primary action is a plain「开始迁移」', panelHtml.includes('开始迁移') && !panelHtml.includes('预检'), 'the preflight step must be folded into the action')
ok('the panel no longer prints the home directory or the engine path', !panelHtml.includes('DSH_HOME:') && !panelHtml.includes('引擎:'), 'internal paths are not user-facing')
ok('the manual-flow explanation lives behind an「i」, not in the label', !panelHtml.includes('手动迁移（') && /dwsm-i[^>]*>i</.test(panelHtml), 'the checkbox label must be just「手动迁移」')
ok('「从」is picker-only', panelHtml.includes('readOnly'), 'the source path must come from the workspace picker')
ok('the destination choice is a two-option slider, files first', panelHtml.includes('连同文件迁移') && panelHtml.includes('仅修改目录') && /dwsm-mode-on">连同文件迁移/.test(panelHtml), '「连同文件迁移」must be the default')
ok('no「自动备份目标并覆盖」option is offered', !panelHtml.includes('自动备份') && !panelHtml.includes('备份目标'), 'nothing may be parked or overwritten: a non-empty destination fails the check')
ok('no crash placeholder leaked into the markup', !panelHtml.includes('undefined'))

console.log('\n[5] entries')
const sidebarHtml = rendered['sidebar.footer.action'] ? rendered['sidebar.footer.action'].second : ''
const headerHtml = rendered['conversation.session.header.actions'] ? rendered['conversation.session.header.actions'].second : ''
ok('the sidebar entry is a button', sidebarHtml.startsWith('<button'))
ok('the sidebar entry is labelled', sidebarHtml.includes('迁移'))
ok('the header entry is a button', headerHtml.startsWith('<button'))
ok('the header entry is labelled', headerHtml.includes('迁移工作区'))

// The sidebar foot's owner prop is `wide` (false = the 56px rail), so the entry can drop its label
// exactly where a two-character label would wrap vertically. Same seat contract dsh-session-manager
// uses for the same slot.
{
	const sidebarEntry = registrations.find((r) => r.options.name === 'sidebar.footer.action').component
	const railHtml = (await renderFresh(sidebarEntry, { wide: false })).second
	const wideHtml = (await renderFresh(sidebarEntry, { wide: true })).second
	ok('in the collapsed rail the entry drops its label', !railHtml.includes('>迁移<'), railHtml)
	ok('and carries the rail class instead', railHtml.includes('dwsm-entry-rail'), railHtml)
	ok('the glyph stays', railHtml.includes('⇄'), railHtml)
	ok('the name survives for pointer and screen readers', railHtml.includes('title="工作区迁移"') && railHtml.includes('aria-label="工作区迁移"'), railHtml)
	ok('a wide sidebar keeps the label', wideHtml.includes('>迁移<') && !wideHtml.includes('dwsm-entry-rail'), wideHtml)
	ok('an owner that passes no prop falls back to the labelled form', sidebarHtml.includes('>迁移<') && !sidebarHtml.includes('dwsm-entry-rail'), sidebarHtml)
	// The rail button must be a square target, not a padded strip: the entry is the only thing in
	// the rail row, and a narrow one would sit off-centre in the owner's centered flex container.
	ok('the rail styling is a square icon button', headChildren.length > 0 && /\.dwsm-entry-rail\{[^}]*width:36px;height:36px/.test(headChildren[0].textContent), 'the rail variant needs its own box')
	// The prop is not the only signal: the label itself must never wrap (a soft-wrapped two-character
	// label is what stacked vertically in the rail), and the layout frame's DOM attribute drops it
	// even on a build that stops passing `wide`.
	const css = headChildren.length > 0 ? headChildren[0].textContent : ''
	ok('the label is declared nowrap', /\.dwsm-entry-label\{white-space:nowrap;\}/.test(css), 'a wrapping label is the original bug')
	ok('the collapsed frame hides the label by DOM attribute, not only by prop', /\[data-sidebar-collapsed="true"\] \.dwsm-entry \.dwsm-entry-label\{display:none;\}/.test(css), 'the rail needs a prop-independent rule')
	ok('and squares the button in the same state', /\[data-sidebar-collapsed="true"\] \.dwsm-entry\{[^}]*width:36px;height:36px/.test(css), 'the rail rule must carry the box, not only the label hiding')
}

console.log('\n[6] stylesheet injection')
ok('a <style> tag was appended to document.head', headChildren.length === 1, `got ${headChildren.length}`)
ok('the style tag is tagged with the plugin name', headChildren[0] && headChildren[0].dataset.plugin === 'dsh-workspace-migrate')
ok('the stylesheet declares every class used in markup', ['dwsm-root', 'dwsm-btn', 'dwsm-card', 'dwsm-overlay', 'dwsm-dialog', 'dwsm-entry'].every((cls) => headChildren[0] && headChildren[0].textContent.includes('.' + cls)))

console.log('\n[7] a failing seat must not cost the others')
{
	const partial = []
	const explodingSlots = {
		inject(key, callback) {
			if (key === 'settings.section') throw new Error('simulated slot failure')
			const disposer = callback()
			return typeof disposer === 'function' ? disposer : () => {}
		},
		register(options) {
			partial.push(options.name)
			return () => {}
		},
	}
	let threw = null
	try {
		exportsObject.apply({ get: () => explodingSlots, effect: (fn) => fn() })
	} catch (error) {
		threw = error
	}
	ok('apply() survives a failing seat', threw === null, threw && threw.message)
	ok('the other three seats still registered', partial.length === 3, partial.join(', '))
	ok('the failing seat is the only one missing', !partial.includes('settings.section'))
}

console.log('\n[8] the conversation-header entry preselects its own session workspace')
{
	const headerComponent = registrations.find((r) => r.options.name === 'conversation.session.header.actions').component
	const overlayComponent = registrations.find((r) => r.options.name === 'shell.overlay').component

	const withoutSession = headerComponent({})
	ok('the header entry renders a button', withoutSession.type === 'button')
	ok('the header entry exposes a click handler', typeof withoutSession.props.onClick === 'function')

	// The seat is session-scoped, so the real Owner passes sessionId.
	const withSession = headerComponent({ sessionId: 'session-from-props' })
	withSession.props.onClick()

	fetchCalls.length = 0
	const dialog = await renderFresh(overlayComponent)
	ok('clicking the entry opens the dialog', dialog.second.length > 0, `${dialog.second.length} chars`)
	ok('the dialog resolved the session id against the host', fetchCalls.some((entry) => entry.url === '/api/dsh-workspace-migrate/session' && entry.method === 'POST'), JSON.stringify(fetchCalls))
	ok('the dialog prefilled「从」with the session workspace', dialog.second.includes('value="D:/old/DemoProject"'), 'prefill missing')

	// The picker is a controlled <select>, so its own tag must carry the selected workspace
	// rather than a constant empty value. Asserting on the whole markup would pass spuriously,
	// because the「从」text input carries the same path string.
	const selectTag = /<select[^>]*>/.exec(dialog.second)
	ok(
		'the workspace picker reflects the preselected workspace',
		selectTag !== null && selectTag[0].includes('value="D:/old/DemoProject"'),
		selectTag === null ? 'no <select> rendered' : selectTag[0],
	)
	const settingsSelectTag = /<select[^>]*>/.exec(panelHtml)
	ok(
		'with nothing selected the picker falls back to the placeholder',
		settingsSelectTag !== null && settingsSelectTag[0].includes('value=""'),
		settingsSelectTag === null ? 'no <select> rendered' : settingsSelectTag[0],
	)

	// A non-session entry (the sidebar seat) must NOT preselect anything.
	const sidebarComponent = registrations.find((r) => r.options.name === 'sidebar.footer.action').component
	sidebarComponent({}).props.onClick()
	fetchCalls.length = 0
	const plainDialog = await renderFresh(overlayComponent)
	ok('the sidebar entry opens the dialog too', plainDialog.second.length > 0)
	ok('the sidebar entry does NOT call /session', !fetchCalls.some((entry) => entry.url === '/api/dsh-workspace-migrate/session'), JSON.stringify(fetchCalls))
}

console.log('\n[7] signal markers in the result dialog')
{
	// The user reads this dialog to decide whether something went wrong. Every line has to say
	// which it is: `[√]` done, `[!]` degraded but handled, `[×]` failed, `[i]` context. The detail
	// lives in a collapsed row, so the summary carries a status chip with a colour class.
	const success = await renderPanelWith({
		from: 'D:/old/DemoProject',
		to: 'E:/new/DemoProject',
		liveInspect: { ok: true, blockers: [], notes: [], project: { willMove: true, sourceExists: true, destinationExists: false }, sessionIds: ['session-a'] },
		liveResult: {
			ok: true,
			stage: 'done',
			from: 'D:/old/DemoProject',
			to: 'E:/new/DemoProject',
			movedCount: 2,
			workspaceCreated: true,
			workspaceTitle: 'DemoProject',
			projectMoved: true,
			sessionIds: ['session-a', 'session-b'],
			notes: [
				'[√] 1 session(s) are running and will be relocated in process, without interrupting them',
				'[√] project directory moved (robocopy /E /MOVE): D:/old/DemoProject -> E:/new/DemoProject',
				'[!] the projection cache could not be checkpointed for session-a; it self-heals on the next write',
				'[i] 1 session(s) with this cwd are stored but not indexed on the workspace; they are included',
				'legacy unmarked note from an older host',
			],
		},
	})
	ok('the success header is marked done', success.includes('[√] 迁移完成（全程未关闭 DSH）'), success.slice(0, 200))
	ok('a positive note keeps its own marker', success.includes('[√] 1 session(s) are running'), 'missing the running-session note')
	ok('a degraded note is a warning, not a failure', success.includes('[!] the projection cache could not be checkpointed'))
	ok('an informational note is marked as context', success.includes('[i] 1 session(s) with this cwd are stored'))
	ok('a marked note is not double-labelled with「提示」', !success.includes('提示: [√]') && !success.includes('提示: [!]'), 'the host marker and the fallback label both rendered')
	ok('an unmarked legacy note still gets a label', success.includes('提示: legacy unmarked note'))

	// One summary row per phase, coloured by status, collapsed by default.
	ok('the check result is a labelled row', success.includes('dwsm-disc-title">Check<'), success.slice(0, 400))
	ok('the migrate result is a labelled row', success.includes('dwsm-disc-title">Migrate<'))
	ok('a successful row carries the success chip', success.includes('dwsm-chip-ok">成功<'), 'missing the success chip')
	ok('a failed row carries the failure chip', !success.includes('dwsm-chip-bad">失败<'), 'a successful run must not show a failure chip')
	// The stub renders React prop names as attribute names, so the body tag is `className=`.
	ok('the rows are one click targets', success.includes('role="button"') && success.includes('aria-expanded="false"'), 'the summary row must announce its state')
	ok('the row header is not a button wrapping a button', !/<button[^>]*className="dwsm-disc-head"/.test(success), 'a button inside a button is invalid HTML')
	ok('a successful row stays collapsed', /className="dwsm-disc-body" hidden="true">[\s\S]*?迁移完成/.test(success), 'a success needs no unfold')

	// The check gates the write: a refused check means no migration, and its reason is shown.
	const failure = await renderPanelWith({
		from: 'D:/old/DemoProject',
		to: 'E:/new/DemoProject',
		liveResult: {
			ok: false,
			stage: 'memory-layer',
			blockers: ['the workspace registry refused the re-point: duplicate JSONL session id "session-a" appears in multiple project directories'],
			rollback: { filesRestored: true, undoErrors: [], memoryErrors: [] },
			notes: ['[!] the registry exposes no header index to invalidate; validation will read from disk'],
		},
	})
	ok('the failure header is marked failed', failure.includes('[×] 迁移失败（阶段：memory-layer）'), failure.slice(0, 200))
	ok('a blocker is marked failed', failure.includes('[×] the workspace registry refused the re-point'))
	ok('a successful rollback reads as a positive', failure.includes('[√] 文件已还原: 是'))
	ok('a degraded note stays a warning', failure.includes('[!] the registry exposes no header index'))
	ok('the failed row is opened for the user', /className="dwsm-disc-body">[\s\S]*?迁移失败/.test(failure), 'a failure must show its reason without a further click')

	const blocked = await renderPanelWith({
		liveInspect: {
			ok: false,
			blockers: ['the destination already exists: E:/new/DemoProject — remove it, or leave the project where it is and move it yourself'],
			notes: [],
			project: { willMove: false, sourceExists: true, destinationExists: true },
			sessionIds: [],
		},
	})
	ok('a refused check is marked failed', blocked.includes('[×] 检查未通过'), blocked.slice(0, 200))
	ok('its blockers are marked failed', blocked.includes('[×] the destination already exists'))
	ok('a refused check carries the failure chip', blocked.includes('dwsm-chip-bad">失败<'))
	ok('no migration result is shown when the check refused', !blocked.includes('dwsm-disc-title">Migrate<'))

	// Manual mode turns the same button into「计划」and the plan row offers the folder.
	const manualPanel = await renderPanelWith({ manual: true, from: 'D:/old/DemoProject', to: 'E:/new/DemoProject' })
	ok('manual mode relabels the action to「生成计划」', manualPanel.includes('>生成计划<') && !manualPanel.includes('>开始迁移<'), 'the action label must follow the checkbox')

	const plan = await renderPanelWith({
		manual: true,
		plan: {
			ok: true,
			oldKey: '--D-old-DemoProject--',
			newKey: '--E-new-DemoProject--',
			sessions: { toMigrate: [{}], foreign: [], alreadyAtNew: [] },
			metadata: { patches: [{}] },
			project: { action: 'move' },
			running: { dshProcesses: [] },
			warnings: [],
			errors: [],
			stage: { dir: 'C:/Users/probe/.dsh/migration-runs/run-1', planFile: 'C:/Users/probe/.dsh/migration-runs/run-1/plan.json', applyCmd: 'a.cmd', verifyCmd: 'v.cmd', rollbackCmd: 'r.cmd' },
		},
	})
	ok('the plan result is one labelled row', plan.includes('dwsm-disc-title">Plan<'), plan.slice(0, 300))
	ok('the plan row carries its status chip', plan.includes('dwsm-chip-ok">可执行<'))
	ok('the plan row offers to open the staged directory without expanding', plan.includes('打开目录'), 'the open-directory action belongs on the summary row')
	ok('rollback is presented as the way out, not as step 3 of the happy path', plan.includes('若遇到错误，可以回滚：') && plan.indexOf('若遇到错误，可以回滚：') > plan.indexOf('2-verify'), 'rollback needs its own subheading after steps 1 and 2')
	ok('no verify button is offered inside the plan', !plan.includes('立即只读校验'), 'verify is the second script, run while DSH is down')
	// The action hugs the status chip; only the spacer follows it.
	const planHead = plan.slice(plan.indexOf('dwsm-disc-title">Plan<'), plan.indexOf('dwsm-disc-body'))
	ok(
		'the plan action sits right after its status chip',
		planHead.indexOf('打开目录') > planHead.indexOf('dwsm-chip-ok') && planHead.indexOf('打开目录') < planHead.indexOf('dwsm-spacer'),
		planHead,
	)
	ok('the plan result stays collapsed to one line', plan.includes('dwsm-disc-title">Plan<') && plan.includes('hidden="true"'), 'a plan must not unfold by itself')

	// The staged rows are bare paths now, so the steps live behind the「i」on the row header.
	const hint = await renderPanelWith({ expanded: { hint: true } })
	ok('the staged row carries an「i」help button', /dwsm-i[^>]*>i</.test(hint), hint.slice(hint.indexOf('暂存的手动迁移'), hint.indexOf('暂存的手动迁移') + 300))
	ok('the help explains what to do with a staged run', hint.includes('先点「打开目录」') && hint.includes('1-apply-migration.cmd') && hint.includes('2-verify.cmd') && hint.includes('3-rollback.cmd'), 'the steps must be spelled out')
	ok('the help is closed until asked for', (await renderPanelWith({})).includes('用法：') === false, 'the hint must not be shown by default')

	// Launching a file manager changes nothing inside the page, so the row has to say what
	// happened at the click site — otherwise a working button looks dead.
	const notice = await renderPanelWith({ openNotice: { row: 'runs', ok: true, text: '已请求系统打开（若窗口没弹出，请看运行 DSH 的终端）：C:/Users/probe/.dsh/migration-runs/run-1' } })
	ok('the open result is reported next to the row that asked', notice.includes('已请求系统打开') && notice.includes('若窗口没弹出'), 'a successful launch needs visible feedback')
	// A notice is row-scoped, so the failing case needs the row it belongs to.
	const planNotice = await renderPanelWith({
		openNotice: { row: 'plan', ok: false, text: '宿主半体还是旧版本' },
		plan: { ok: true, oldKey: '--a--', newKey: '--b--', sessions: { toMigrate: [{}], foreign: [], alreadyAtNew: [] }, metadata: { patches: [] }, project: { action: 'keep' }, running: { dshProcesses: [] }, warnings: [], errors: [], stage: { dir: 'C:/Users/probe/.dsh/migration-runs/run-1', planFile: 'p', applyCmd: 'a', verifyCmd: 'v', rollbackCmd: 'r' } },
	})
	ok('a failed open is reported the same way', planNotice.includes('[×] 宿主半体还是旧版本'), 'a stale host must be named at the click site')
	ok('a notice only appears on its own row', !notice.includes('宿主半体还是旧版本'), 'notices must not leak across rows')
}

// ── the manual flow checks the destination before it writes a plan ─────────
console.log('\n[12] manual mode runs the check first and is gated by it')
{
	const routes = () => fetchCalls.map((entry) => entry.url.replace('/api/dsh-workspace-migrate', '')).filter((route) => route !== '/state' && route !== '/session')
	const bodyOf = (route) => {
		const entry = [...fetchCalls].reverse().find((call) => call.url.endsWith(route))
		return entry === undefined || typeof entry.body !== 'string' ? {} : JSON.parse(entry.body)
	}

	// A passing check: the check is asked FIRST, narrowed to what holds with DSH stopped, and only
	// then is the plan written.
	fetchCalls.length = 0
	inspectReply = { ok: true, blockers: [], notes: ['[i] the destination is empty'], project: { willMove: true, sourceExists: true, destinationExists: true, destinationHasContent: false }, sessionIds: [], liveIds: [], projectOnly: true }
	planReply = { ok: true, json: { ok: true, oldKey: '--a--', newKey: '--b--', sessions: { toMigrate: [{}], foreign: [], alreadyAtNew: [] }, metadata: { patches: [] }, project: { action: 'move' }, running: { dshProcesses: [] }, warnings: [], errors: [], stage: { dir: 'C:/Users/probe/.dsh/migration-runs/run-2', planFile: 'p', applyCmd: 'a', verifyCmd: 'v', rollbackCmd: 'r' } } }
	const okPlan = await clickPanelButton({ manual: true, from: 'D:/old/DemoProject', to: 'E:/new/DemoProject' }, '生成计划')
	ok('the manual action asks the check before the plan', routes().join(' -> ') === '/live-inspect -> /plan', routes().join(' -> '))
	ok('and it asks for the project-only check', bodyOf('/live-inspect').projectOnly === true, JSON.stringify(bodyOf('/live-inspect')))
	ok('the check is told whether the files move too', bodyOf('/live-inspect').moveProject === true, JSON.stringify(bodyOf('/live-inspect')))
	ok('a passing check is shown as its own row', okPlan.includes('dwsm-disc-title">Check<') && okPlan.includes('dwsm-chip-ok">通过<'), okPlan.slice(0, 200))
	ok('a passing check still produces the plan', okPlan.includes('dwsm-disc-title">Plan<'), okPlan.slice(0, 300))

	// A destination that is not empty: the plan must NOT be written at all.
	fetchCalls.length = 0
	inspectReply = { ok: false, blockers: ['the destination is not empty: E:/new/DemoProject — empty it yourself, or choose "only change the path" if the workspace should simply point there'], notes: [], project: { willMove: true, sourceExists: true, destinationExists: true, destinationHasContent: true }, sessionIds: [], projectOnly: true }
	planReply = null
	const refused = await clickPanelButton({ manual: true, from: 'D:/old/DemoProject', to: 'E:/new/DemoProject' }, '生成计划')
	ok('a refused check stops the manual flow before the plan', !routes().includes('/plan'), routes().join(' -> '))
	ok('the refusal is shown in the Check row', refused.includes('[×] 检查未通过') && refused.includes('the destination is not empty'), refused.slice(0, 300))
	ok('and no plan row appears', !refused.includes('dwsm-disc-title">Plan<'), refused.slice(0, 300))

	// Moving the files is what makes a populated destination fatal; with「仅修改目录」the same
	// click must still generate its plan (the check is asked with moveProject:false).
	fetchCalls.length = 0
	inspectReply = { ok: true, blockers: [], notes: [], project: { willMove: false, sourceExists: true, destinationExists: true, destinationHasContent: true }, sessionIds: [], projectOnly: true }
	planReply = { ok: true, json: { ok: true, oldKey: '--a--', newKey: '--b--', sessions: { toMigrate: [{}], foreign: [], alreadyAtNew: [] }, metadata: { patches: [] }, project: { action: 'keep' }, running: { dshProcesses: [] }, warnings: [], errors: [], stage: { dir: 'C:/Users/probe/.dsh/migration-runs/run-3', planFile: 'p', applyCmd: 'a', verifyCmd: 'v', rollbackCmd: 'r' } } }
	const keepPlan = await clickPanelButton({ manual: true, moveFiles: false, from: 'D:/old/DemoProject', to: 'E:/new/DemoProject' }, '生成计划')
	ok('「仅修改目录」asks the check with moveProject off', bodyOf('/live-inspect').moveProject === false, JSON.stringify(bodyOf('/live-inspect')))
	ok('and the plan is still written', keepPlan.includes('dwsm-disc-title">Plan<'), keepPlan.slice(0, 300))

	// The live flow's own gate, for contrast: the same click on「开始迁移」asks the FULL check.
	fetchCalls.length = 0
	inspectReply = { ok: true, blockers: [], notes: [], project: { willMove: true, sourceExists: true, destinationExists: true, destinationHasContent: false }, sessionIds: ['session-a'], liveIds: [] }
	moveReply = { ok: true, from: 'D:/old/DemoProject', to: 'E:/new/DemoProject', sessionIds: ['session-a'], movedCount: 1, workspaceTitle: 'DemoProject', workspaceCreated: false, projectMoved: true, notes: [] }
	await clickPanelButton({ from: 'D:/old/DemoProject', to: 'E:/new/DemoProject' }, '开始迁移')
	ok('the live action asks the full check, not the project-only one', bodyOf('/live-inspect').projectOnly !== true, JSON.stringify(bodyOf('/live-inspect')))
	ok('and then performs the move', routes().includes('/live-move'), routes().join(' -> '))
	inspectReply = null
	planReply = null
	moveReply = null
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
