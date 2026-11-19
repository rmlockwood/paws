// PAWS web proof of concept: app shell + the `pawsApp` bridge the existing pages call.
// Mirrors org.sil.paws.service.WebPageInteractor and parts of RootLayoutController.

import { Language } from './language.js';
import { loadXml, fetchText } from './dtd.js';
import { transformToHtml, transformToText } from './xslt.js';
import * as files from './files.js';

const RESOURCES = new URL('/resources/', location.href);
const CONFIG = new URL('configuration/', RESOURCES);
const HTMS = new URL('HTMs/', CONFIG);
const PAGE_MAPPER = new URL('Transforms/PAWSSKHtmlMapper.xsl', CONFIG);
const GRAMMAR_MAPPER = new URL('Transforms/PAWSSKMasterGrammarMapper.xsl', CONFIG);
const LOCALES = ['en', 'es', 'fr'];

const state = {
	lang: null,         // Language
	handle: null,       // FileSystemFileHandle of the .paw file, or null if untitled
	locale: initialLocale(),
	current: null,      // URL of the page in the frame
	history: [],
	strings: null,      // paws_xx.properties
	saveTimer: null,
	saving: Promise.resolve(),
};

const $ = id => document.getElementById(id);
const frame = $('page');

// ---------------------------------------------------------------- status

function setStatus(message, kind = 'info') {
	const el = $('status-message');
	el.textContent = message;
	el.dataset.kind = kind;
}

function showError(e) {
	console.error(e);
	setStatus(e?.message || String(e), 'error');
}

function updateFileLabel() {
	const name = state.handle?.name ?? (state.lang ? 'Untitled (not saved yet)' : 'No language open');
	$('file-name').textContent = name;
	const flag = $('dirty-flag');
	flag.hidden = !(state.lang?.dirty);
	for (const id of ['btn-save', 'btn-save-as', 'btn-contents', 'btn-generate']) $(id).disabled = !state.lang;
	$('btn-back').disabled = state.history.length === 0;
}

// ---------------------------------------------------------------- locale & strings

function initialLocale() {
	let saved = null;
	try { saved = localStorage.getItem('paws.locale'); } catch { /* storage unavailable */ }
	const code = saved || navigator.language.slice(0, 2);
	return '_' + (LOCALES.includes(code) ? code : 'en');
}

async function loadStrings() {
	const decode = buf => {
		try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
		catch { return new TextDecoder('iso-8859-1').decode(buf); }
	};
	let res = await fetch(new URL(`paws${state.locale}.properties`, RESOURCES));
	if (!res.ok) res = await fetch(new URL('paws.properties', RESOURCES));
	const strings = {};
	for (const raw of decode(await res.arrayBuffer()).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith('!')) continue;
		const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
		if (m) strings[m[1]] = m[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
	}
	state.strings = strings;
}

const str = key => state.strings?.[key] ?? '';

// ---------------------------------------------------------------- page loading

async function fetchHtml(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status} loading ${url.pathname}`);
	const buf = await res.arrayBuffer();
	try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
	catch { return new TextDecoder('windows-1252').decode(buf); }
}

function fontStyle(cssClass, path) {
	const v = p => state.lang.getValue(path + p);
	let css = `${cssClass} {font-family: ${v('fontName')};font-size: ${v('fontSize')}pt;color: ${v('fontColor')};`;
	if (v('@bold') === 'True') css += 'font-weight: bold;';
	if (v('@italic') === 'True') css += 'font-style: italic;';
	const deco = [v('@under') === 'True' && 'underline', v('@strike') === 'True' && 'line-through'].filter(Boolean);
	if (deco.length) css += `text-decoration: ${deco.join(' ')};`;
	return css + '}\n';
}

async function pageParams() {
	const v = p => state.lang?.getValue(p) ?? '';
	const css = await fetchText(new URL('Styles/PAWSStarterKitMaster.css', CONFIG));
	const fonts = state.lang
		? fontStyle('.vernacular', '//language/font/') + fontStyle('.free', '//language/freeFont/') + fontStyle('.ipa', '//language/ipaFont/')
		: '';
	return {
		prmInstallPath: CONFIG.href,
		prmLangAbbr: v('/paws/language/langAbbr'),
		prmRtlScript: v('/paws/language/font/@rtl'),
		prmInterlinearOutputStyle: v('/paws/language/interlinearOutputStyle/@style'),
		prmStylesheet: css + fonts,
		prmWorkingPath: '',
		prmLocale: state.locale,
		prmBackLabel: str('webpage.back'),
		prmNextLabel: str('webpage.next'),
		prmReturnToContentsLabel: str('webpage.returntocontents'),
		prmTypeOfFeature: str('webpage.typeoffeature'),
		prmFeature: str('webpage.feature'),
		prmExplanation: str('webpage.explanation'),
		prmMorphemes: str('webpage.morphemes'),
		prmOutputGrammar: v('/paws/@outputGrammar'),
		prmVernacular: str('webpage.vernacular'),
		prmFree: str('webpage.free'),
		prmIpa: str('webpage.ipa'),
		prmGloss: str('webpage.gloss'),
		prmAddExample: str('webpage.addexample'),
	};
}

function injectHead(html, baseHref) {
	// The bridge must exist before the page's own scripts run.
	const inject = `<base href="${baseHref}"><script>window.pawsApp = parent.pawsBridge;<\/script>`;
	return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : inject + html;
}

/** Load a page into the frame. `.xml` pages are page descriptions run through PAWSSKHtmlMapper.xsl. */
async function showPage(target, { push = true } = {}) {
	try {
		const url = new URL(target, state.current ?? HTMS);
		if (url.pathname.endsWith('LeftOffAt')) return goBack();
		let html;
		let base = url;
		if (/\.xml$/i.test(url.pathname)) {
			if (!state.lang) {
				setStatus('Open or create a language first.', 'warn');
				return;
			}
			const name = url.pathname.split('/').pop().replace(/\.xml$/i, '');
			setStatus(`Building page ${name}…`);
			const pageDoc = await loadXml(new URL(`XmlPageDescriptions/${name}${state.locale}.xml`, CONFIG));
			html = await transformToHtml(PAGE_MAPPER, pageDoc, await pageParams());
			base = HTMS;
			url.pathname = new URL(`${name}.xml`, HTMS).pathname;
		} else {
			html = await fetchHtml(url);
		}
		if (push && state.current && state.current.href !== url.href) state.history.push(state.current);
		state.current = url;
		frame.srcdoc = injectHead(html, base.href);
		updateFileLabel();
	} catch (e) {
		showError(e);
	}
}

function goBack() {
	const prev = state.history.pop();
	if (prev) showPage(prev, { push: false });
	updateFileLabel();
}

function contentsUrl() {
	return new URL(`Contents${state.locale}.htm`, HTMS);
}

/** Map the stored /paws/leftOffAt value to a page in this app. */
function leftOffAtUrl() {
	const stored = state.lang.getValue('/paws/leftOffAt');
	const file = stored.split(/[\\/]/).pop();
	const m = file.match(/^(.*?)(?:_(en|es|fr))?\.htm$/i);
	if (!m) return contentsUrl();
	if (m[2] || m[1] === 'Contents') return new URL(`${m[1]}${state.locale}.htm`, HTMS);
	return new URL(`${m[1]}.xml`, HTMS);
}

frame.addEventListener('load', () => {
	if (!state.current) return;
	const win = frame.contentWindow;
	const doc = frame.contentDocument;
	doc.addEventListener('click', onFrameClick, true);
	$('page-title').textContent = doc.title || '';
	setStatus('');
	try {
		if (typeof win.Initialize === 'function') win.Initialize(state.locale);
	} catch (e) {
		showError(new Error(`Page script error: ${e.message}`));
	}
});

function onFrameClick(e) {
	const a = e.target.closest?.('a[href]');
	if (!a) return;
	const href = a.getAttribute('href');
	if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
	const url = new URL(href, a.baseURI);
	e.preventDefault();
	if (url.origin !== location.origin) {
		window.open(url, '_blank', 'noopener');
	} else if (/\.(xml|htm|html)$/i.test(url.pathname) || url.pathname.endsWith('LeftOffAt')) {
		showPage(url);
	} else {
		window.open(url, '_blank');
	}
}

// ---------------------------------------------------------------- saving

/** Called by pages (via pawsApp.saveData) after almost every change; debounced. */
function scheduleAutosave() {
	updateFileLabel();
	if (!state.handle) return; // untitled: the user saves explicitly
	if (state.oldVersionWarning) {
		// Don't silently rewrite a file the desktop app would migrate first.
		setStatus(state.oldVersionWarning, 'warn');
		return;
	}
	clearTimeout(state.saveTimer);
	state.saveTimer = setTimeout(() => saveNow({ ask: false }).catch(showError), 400);
}

async function saveNow({ ask = true } = {}) {
	if (!state.lang) return;
	if (!state.handle) return ask ? saveAs() : undefined;
	clearTimeout(state.saveTimer);
	state.saving = state.saving.then(async () => {
		if (!(await files.ensurePermission(state.handle, { ask }))) {
			setStatus('Click Save to let PAWS write to this file again.', 'warn');
			return;
		}
		await files.writeText(state.handle, state.lang.serialize());
		state.lang.dirty = false;
		state.oldVersionWarning = null; // the user chose to save it explicitly
		updateFileLabel();
		setStatus(`Saved ${state.handle.name} at ${new Date().toLocaleTimeString()}`);
	});
	return state.saving;
}

async function saveAs() {
	try {
		const abbr = state.lang.getValue('/paws/language/langAbbr') || 'language';
		const handle = await files.pickSaveTarget({
			id: 'paws-language',
			suggestedName: `${abbr}.paw`,
			description: 'PAWS language file (*.paw)',
			extension: '.paw',
		});
		state.handle = handle;
		await files.rememberHandle('language', handle);
		await saveNow();
	} catch (e) {
		if (!files.isAbort(e)) showError(e);
	}
}

// ---------------------------------------------------------------- open / new

async function openLanguageFromHandle(handle) {
	const lang = Language.parse(await files.readText(handle));
	const dbversion = Number(lang.getValue('/paws/@dbversion'));
	state.lang = lang;
	state.handle = handle;
	state.history = [];
	state.current = null;
	state.oldVersionWarning = dbversion < 15
		? `${handle.name} is data version ${dbversion}. Data migration is not in the proof of concept, so changes are only written when you click Save. Open it in desktop PAWS first to upgrade it.`
		: null;
	await files.rememberHandle('language', handle);
	$('reopen').hidden = true;
	updateFileLabel();
	await showPage(leftOffAtUrl(), { push: false });
}

async function openLanguage() {
	try {
		const handle = await files.pickLanguageToOpen();
		// The picker only grants read access; ask for write access now (still within the
		// user's click) so autosave works. If they decline, Save will ask again.
		await files.ensurePermission(handle).catch(() => false);
		await openLanguageFromHandle(handle);
	} catch (e) {
		if (!files.isAbort(e)) showError(e);
	}
}

async function reopenLast() {
	try {
		const handle = await files.recallHandle('language');
		if (!handle) return;
		if (!(await files.ensurePermission(handle))) return;
		await openLanguageFromHandle(handle);
	} catch (e) {
		showError(e);
	}
}

async function newLanguage() {
	try {
		if (state.lang?.dirty && !confirm('Discard unsaved changes to the current language?')) return;
		const text = await fetchText(new URL('Data/PAWSStarterKitMaster.paw', CONFIG));
		state.lang = Language.parse(text);
		state.lang.dirty = true;
		state.handle = null;
		state.oldVersionWarning = null;
		state.history = [];
		state.current = null;
		updateFileLabel();
		await showPage(new URL(`LanguageProperties${state.locale}.htm`, HTMS), { push: false });
		setStatus('New language. Click Save to choose where to keep it.', 'warn');
	} catch (e) {
		showError(e);
	}
}

// ---------------------------------------------------------------- output

const grammarKey = () => `grammar:${state.handle?.name ?? 'untitled'}`;

async function chooseGrammarFile() {
	const current = state.lang.getValue('//language/grammarFile').split(/[\\/]/).pop();
	const abbr = state.lang.getValue('/paws/language/langAbbr') || 'grammar';
	const handle = await files.pickSaveTarget({
		id: 'paws-output',
		suggestedName: current ? current.replace(/\.[^.]*$/, '') + '.grm' : `${abbr}.grm`,
		description: 'PC-PATR grammar (*.grm)',
		extension: '.grm',
	});
	await files.rememberHandle(grammarKey(), handle);
	// Keep a desktop path if one is already stored; otherwise record the file name.
	if (!state.lang.getValue('//language/grammarFile')) {
		state.lang.setValue('//language/grammarFile', handle.name);
		scheduleAutosave();
	}
	return handle;
}

async function generateGrammar(forcePick = false) {
	try {
		let handle = forcePick ? null : await files.recallHandle(grammarKey());
		if (!handle || !(await files.ensurePermission(handle))) handle = await chooseGrammarFile();
		setStatus('Generating grammar…');
		const started = performance.now();
		const grammar = await transformToText(GRAMMAR_MAPPER, state.lang.doc);
		await files.writeText(handle, grammar);
		const ms = Math.round(performance.now() - started);
		setStatus(`Wrote ${handle.name}: ${grammar.split('\n').length} lines in ${ms} ms. Shift+click to choose a different file.`);
	} catch (e) {
		if (!files.isAbort(e)) showError(e);
	}
}

// ---------------------------------------------------------------- the bridge

function notInPoc(what) {
	alert(`${what} is not part of the web proof of concept yet.`);
}

const bridge = {
	getAnswerValue: xpath => state.lang?.getValue(xpath) ?? '',
	setAnswerValue: (xpath, value) => state.lang?.setValue(xpath, value),
	getFormsLength: xpath => state.lang?.getFormsLength(xpath) ?? 1,
	createNewFormEntry: (xpath, index) => state.lang?.createNewFormEntry(xpath, index),
	saveData: () => scheduleAutosave(),
	setLeftOffAt: value => {
		state.lang?.setValue('/paws/leftOffAt', value);
		scheduleAutosave();
	},
	load: page => showPage(page),
	launchFile: file => window.open(new URL(file, state.current ?? HTMS), '_blank'),
	launchFileAsIs: file => window.open(file, '_blank'),
	launchWebPage: site => window.open(site, '_blank', 'noopener'),
	showTermDefinition: msg => alert(msg),
	showSomething: something => console.log(something),
	languageNameChanged: () => updateFileLabel(),
	createNewLanguage: () => newLanguage(),
	getInterfaceLanguage: () => state.locale.slice(1),
	setInterfaceLanguage: code => setLocale('_' + code),
	saveInterfaceLanguage: () => {},
	CopyFiles: () => {}, // localization files are chosen by locale on the web; nothing to copy
	initAnswerTransforms: () => {},

	// Pages expect these to block and return a path. The web version opens the
	// picker asynchronously and refreshes the page when the user has chosen.
	fileBrowse: (current, description, extensions) => {
		if (/grm/i.test(extensions)) {
			chooseGrammarFile().then(() => showPage(state.current, { push: false })).catch(e => files.isAbort(e) || showError(e));
		} else if (/paw/i.test(extensions)) {
			saveAs().then(() => showPage(state.current, { push: false }));
		} else {
			notInPoc('Choosing writer output files');
		}
		return 'Cancel';
	},
	directoryBrowse: () => {
		notInPoc('Choosing the example files folder');
		return 'Cancel';
	},

	// Fonts and keyboards are desktop features (JavaFX dialogs, JNA keyboard switching).
	changeFontInfo: () => notInPoc('The font dialog'),
	changeFreeFontInfo: () => notInPoc('The font dialog'),
	changeIpaFontInfo: () => notInPoc('The font dialog'),
	changeKeyboards: () => notInPoc('Keyboard selection'),
	changeKeyboardInfo: () => notInPoc('Keyboard selection'),
	changeFreeGlossKeyboardInfo: () => notInPoc('Keyboard selection'),
	changeIpaKeyboardInfo: () => notInPoc('Keyboard selection'),
	keyboardsEnabled: () => false,
	switchToVernacularKeyboard: () => {},
	switchToFreeGlossKeyboard: () => {},
	switchToIpaKeyboard: () => {},
	switchToWriterKeyboard: () => {},
};
// Misspellings that exist in some pages.
bridge.getanswervalue = bridge.getAnswerValue;
bridge.savData = bridge.saveData;
window.pawsBridge = bridge;

// ---------------------------------------------------------------- locale switching

async function setLocale(locale) {
	if (!LOCALES.includes(locale.slice(1)) || locale === state.locale) return;
	state.locale = locale;
	try { localStorage.setItem('paws.locale', locale.slice(1)); } catch { /* ignore */ }
	$('locale').value = locale;
	await loadStrings();
	if (state.current) {
		const url = new URL(state.current);
		url.pathname = url.pathname.replace(/_(en|es|fr)\.htm$/i, `${locale}.htm`);
		await showPage(url, { push: false });
	}
}

// ---------------------------------------------------------------- startup

async function start() {
	$('btn-new').onclick = newLanguage;
	$('btn-open').onclick = openLanguage;
	$('btn-save').onclick = () => saveNow().catch(showError);
	$('btn-save-as').onclick = saveAs;
	$('btn-back').onclick = goBack;
	$('btn-contents').onclick = () => showPage(contentsUrl());
	$('btn-generate').onclick = e => generateGrammar(e.shiftKey);
	$('reopen').onclick = reopenLast;
	$('locale').value = state.locale;
	$('locale').onchange = e => setLocale(e.target.value);
	window.addEventListener('beforeunload', e => {
		if (state.lang?.dirty) e.preventDefault();
	});

	if (!files.isSupported()) {
		$('unsupported').hidden = false;
		for (const b of document.querySelectorAll('header button')) b.disabled = true;
		return;
	}
	await loadStrings();
	const last = await files.recallHandle('language');
	if (last) {
		$('reopen').textContent = `Reopen ${last.name}`;
		$('reopen').hidden = false;
	}
	updateFileLabel();
	await showPage(new URL(`Welcome${state.locale}.htm`, HTMS), { push: false });
}

start().catch(showError);
