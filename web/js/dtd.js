// Load an XML file the way a validating Java parser would see it:
//  - external general entities (e.g. &TechnicalTerms;) are fetched and inlined
//  - internal entities from the DTD (e.g. &nbsp;) are expanded
//  - default attribute values from <!ATTLIST> declarations are applied
//
// Browsers' DOMParser does none of this, and the PAWS stylesheets depend on it
// (for example, textBox/@kind defaults to "interlinear" in PAWSSKHtmlMapper.dtd).

const textCache = new Map();
const dtdCache = new Map();
const NAME = '[\\w.:-]+';
const PREDEFINED = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);

export function fetchText(url) {
	const key = String(url);
	if (!textCache.has(key)) {
		textCache.set(key, fetch(key).then(r => {
			if (!r.ok) throw new Error(`${r.status} loading ${key}`);
			return r.text();
		}));
	}
	return textCache.get(key);
}

const stripComments = s => s.replace(/<!--[\s\S]*?-->/g, '');
const stripXmlDecl = s => s.replace(/^﻿?\s*<\?xml[^?]*\?>/, '');

// Expand parameter entities (%name;), fetching external ones, and return the flat DTD text.
async function expandParameterEntities(text, baseUrl) {
	text = stripComments(text);
	const pes = {};
	const peDecl = new RegExp(`<!ENTITY\\s+%\\s+(${NAME})\\s+(?:(SYSTEM)\\s+)?(["'])([\\s\\S]*?)\\3\\s*>`, 'g');
	for (const m of text.matchAll(peDecl)) {
		const [, name, system, , value] = m;
		if (name in pes) continue; // first declaration wins
		if (system) {
			const url = new URL(value, baseUrl);
			pes[name] = await expandParameterEntities(await fetchText(url), url);
		} else {
			pes[name] = value;
		}
	}
	text = text.replace(peDecl, '');
	return text.replace(new RegExp(`%(${NAME});`, 'g'), (m, n) => (n in pes ? pes[n] : m));
}

// Pull general entities and attribute defaults out of flat DTD text.
function collectDeclarations(text, baseUrl, into) {
	const entDecl = new RegExp(`<!ENTITY\\s+(${NAME})\\s+(?:(SYSTEM)\\s+)?(["'])([\\s\\S]*?)\\3[^>]*>`, 'g');
	for (const [, name, system, , value] of text.matchAll(entDecl)) {
		if (into.entities[name]) continue;
		into.entities[name] = system ? { url: new URL(value, baseUrl) } : { value };
	}
	const attlist = new RegExp(`<!ATTLIST\\s+(${NAME})([\\s\\S]*?)>`, 'g');
	const attDef = new RegExp(
		`(${NAME})\\s+(?:\\([^)]*\\)|NOTATION\\s*\\([^)]*\\)|[A-Z]+)\\s+(?:#REQUIRED|#IMPLIED|(?:#FIXED\\s+)?(["'])([\\s\\S]*?)\\2)`, 'g');
	for (const [, element, body] of text.matchAll(attlist)) {
		const defaults = (into.defaults[element] ??= {});
		for (const [, attr, quote, value] of body.matchAll(attDef)) {
			if (quote && !(attr in defaults)) defaults[attr] = value;
		}
	}
}

async function loadDtd(url) {
	const key = String(url);
	if (!dtdCache.has(key)) {
		dtdCache.set(key, (async () => {
			const decls = { entities: {}, defaults: {} };
			collectDeclarations(await expandParameterEntities(await fetchText(url), url), url, decls);
			return decls;
		})());
	}
	return dtdCache.get(key);
}

async function expandEntities(text, entities, depth = 0) {
	if (depth > 8) throw new Error('Entity expansion nested too deeply');
	const refs = new Set();
	for (const [, name] of text.matchAll(new RegExp(`&(${NAME});`, 'g'))) {
		if (!PREDEFINED.has(name) && entities[name]) refs.add(name);
	}
	if (!refs.size) return text;
	const values = {};
	for (const name of refs) {
		const ent = entities[name];
		const raw = ent.url ? stripXmlDecl(await fetchText(ent.url)) : ent.value;
		values[name] = await expandEntities(raw, entities, depth + 1);
	}
	return text.replace(new RegExp(`&(${NAME});`, 'g'), (m, n) => (n in values ? values[n] : m));
}

export async function loadXml(url) {
	url = new URL(url, location.href);
	return parseXml(await fetchText(url), url);
}

export async function parseXml(text, baseUrl) {
	const doctype = text.match(
		/<!DOCTYPE\s+[\w.:-]+(?:\s+(?:SYSTEM\s+(["'])(.*?)\1|PUBLIC\s+(["']).*?\3\s+(["'])(.*?)\4))?\s*(?:\[([\s\S]*?)\])?\s*>/);
	let decls = { entities: {}, defaults: {} };
	if (doctype) {
		const systemId = doctype[2] ?? doctype[5];
		const internal = doctype[6];
		// Internal subset declarations take precedence over the external DTD.
		if (internal) collectDeclarations(await expandParameterEntities(internal, baseUrl), baseUrl, decls);
		if (systemId) {
			const external = await loadDtd(new URL(systemId, baseUrl));
			for (const [k, v] of Object.entries(external.entities)) decls.entities[k] ??= v;
			for (const [el, attrs] of Object.entries(external.defaults)) {
				decls.defaults[el] = { ...attrs, ...decls.defaults[el] };
			}
		}
		text = text.slice(0, doctype.index) + text.slice(doctype.index + doctype[0].length);
		text = await expandEntities(text, decls.entities);
	}
	const doc = new DOMParser().parseFromString(text, 'application/xml');
	const err = doc.querySelector('parsererror');
	if (err) throw new Error(`XML parse error in ${baseUrl}: ${err.textContent}`);
	applyDefaults(doc, decls.defaults);
	return doc;
}

function applyDefaults(doc, defaults) {
	if (!Object.keys(defaults).length) return;
	for (const el of doc.getElementsByTagName('*')) {
		const attrs = defaults[el.nodeName];
		if (!attrs) continue;
		for (const [name, value] of Object.entries(attrs)) {
			if (!el.hasAttribute(name)) el.setAttribute(name, value);
		}
	}
}
