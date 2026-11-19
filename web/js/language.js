// The answers file (.paw) held in memory. Mirrors org.sil.paws.model.Language.

export class Language {
	constructor(doc) {
		this.doc = doc;
		this.dirty = false;
	}

	static parse(text) {
		const doc = new DOMParser().parseFromString(text, 'application/xml');
		const err = doc.querySelector('parsererror');
		if (err) throw new Error('This file is not valid XML: ' + err.textContent);
		if (doc.documentElement.nodeName !== 'paws') throw new Error('This is not a PAWS language file.');
		return new Language(doc);
	}

	node(xpath) {
		return this.doc.evaluate(xpath, this.doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
	}

	getValue(xpath) {
		try {
			return this.doc.evaluate(xpath, this.doc, null, XPathResult.STRING_TYPE, null).stringValue;
		} catch (e) {
			console.warn('getValue failed for', xpath, e);
			return '';
		}
	}

	setValue(xpath, value) {
		try {
			const node = this.node(xpath);
			if (node) {
				const text = value == null ? '' : String(value);
				if (node.textContent !== text) {
					node.textContent = text;
					this.dirty = true;
				}
			}
		} catch (e) {
			console.warn('setValue failed for', xpath, e);
		}
	}

	getFormsLength(xpath) {
		const node = this.node(xpath);
		if (!node) return 1;
		return [...node.childNodes].filter(n => n.nodeName === 'form').length;
	}

	createNewFormEntry(xpath) {
		const node = this.node(xpath);
		if (!node) return;
		const form = this.doc.createElement('form');
		for (const name of ['vernacular', 'ipa', 'gloss']) form.appendChild(this.doc.createElement(name));
		node.appendChild(form);
		this.dirty = true;
	}

	serialize() {
		return '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(this.doc.documentElement);
	}
}
