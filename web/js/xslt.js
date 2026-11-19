// XSLT for the PAWS web proof of concept, using the browser's built-in XSLTProcessor.
//
// The processor is given a stylesheet as a DOM, so it cannot resolve
// <xsl:include href="..."/> on its own. We fetch and inline included files
// first. (xsl:import is not handled yet; only the writer stylesheets use it.)
//
// Everything outside this file talks to transformToText/transformToHtml, so the
// engine can later be swapped (e.g. for SaxonJS) without touching the rest.

import { fetchText } from './dtd.js';

const XSL_NS = 'http://www.w3.org/1999/XSL/Transform';
const processors = new Map();

async function loadStylesheet(url, seen = new Set()) {
	url = new URL(url, location.href);
	if (seen.has(url.href)) throw new Error(`Circular xsl:include of ${url.href}`);
	seen.add(url.href);
	const doc = new DOMParser().parseFromString(await fetchText(url), 'application/xml');
	const err = doc.querySelector('parsererror');
	if (err) throw new Error(`Stylesheet parse error in ${url}: ${err.textContent}`);

	if (doc.getElementsByTagNameNS(XSL_NS, 'import').length) {
		throw new Error(`${url.pathname} uses xsl:import, which this proof of concept does not support yet`);
	}
	for (const include of [...doc.getElementsByTagNameNS(XSL_NS, 'include')]) {
		const included = await loadStylesheet(new URL(include.getAttribute('href'), url), seen);
		const root = included.documentElement;
		const nsDecls = [...root.attributes].filter(a => a.name.startsWith('xmlns'));
		for (const child of [...root.childNodes]) {
			if (child.nodeType !== Node.ELEMENT_NODE) continue;
			const copy = doc.importNode(child, true);
			// Keep prefixes declared on the included stylesheet in scope for its XPath expressions.
			for (const a of nsDecls) {
				if (!copy.hasAttribute(a.name)) copy.setAttributeNS('http://www.w3.org/2000/xmlns/', a.name, a.value);
			}
			include.parentNode.insertBefore(copy, include);
		}
		include.remove();
	}
	seen.delete(url.href);
	return doc;
}

// Chromium drops one trailing newline from text output, so a grammar ending in "\n"
// would lose it. For text stylesheets we append this marker after the root
// template's output and strip it again in transformToText.
const END_MARK = '';

function addEndMark(sheet) {
	for (const t of sheet.documentElement.children) {
		if (t.namespaceURI === XSL_NS && t.localName === 'template' && t.getAttribute('match') === '/' && !t.hasAttribute('mode')) {
			const text = sheet.createElementNS(XSL_NS, 'xsl:text');
			text.textContent = END_MARK;
			t.appendChild(text);
		}
	}
}

async function getProcessor(xslUrl, { markEnd = false } = {}) {
	const key = String(new URL(xslUrl, location.href));
	if (!processors.has(key)) {
		processors.set(key, loadStylesheet(key).then(sheet => {
			if (markEnd) addEndMark(sheet);
			const proc = new XSLTProcessor();
			proc.importStylesheet(sheet);
			return proc;
		}).catch(e => {
			processors.delete(key);
			throw e;
		}));
	}
	return processors.get(key);
}

async function run(xslUrl, sourceDoc, params, options) {
	if (typeof XSLTProcessor === 'undefined') {
		throw new Error('This browser has no built-in XSLT processor. Use Edge or Chrome, or swap in SaxonJS.');
	}
	const proc = await getProcessor(xslUrl, options);
	proc.clearParameters();
	for (const [name, value] of Object.entries(params)) proc.setParameter(null, name, value ?? '');
	const out = proc.transformToDocument(sourceDoc);
	if (!out || !out.documentElement) throw new Error(`Transform failed: ${xslUrl}`);
	return out;
}

/** For xsl:output method="text" (e.g. the PC-PATR grammar). */
export async function transformToText(xslUrl, sourceDoc, params = {}) {
	// Chromium wraps text output in <html><head></head><body><pre>…</pre></body></html>,
	// with whitespace around the wrapper elements; take only the <pre> content.
	const out = await run(xslUrl, sourceDoc, params, { markEnd: true });
	const pre = out.getElementsByTagName('pre')[0];
	const text = (pre ?? out.documentElement).textContent;
	const end = text.lastIndexOf(END_MARK);
	return end >= 0 ? text.slice(0, end) : text;
}

/** For xsl:output method="html" (e.g. the question pages). */
export async function transformToHtml(xslUrl, sourceDoc, params = {}) {
	return (await run(xslUrl, sourceDoc, params)).documentElement.outerHTML;
}
