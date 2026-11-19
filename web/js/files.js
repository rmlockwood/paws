// Local file access through the File System Access API (Edge and Chrome).
// Handles are kept in IndexedDB so files are remembered between sessions;
// Edge asks the user to re-approve access once per session.

const DB_NAME = 'paws-web';
const STORE = 'handles';

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function withStore(mode, fn) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const req = fn(tx.objectStore(STORE));
		tx.oncomplete = () => resolve(req?.result);
		tx.onerror = () => reject(tx.error);
	});
}

// Remembering is a convenience; if storage is unavailable (e.g. a private window) carry on without it.
export const rememberHandle = (key, handle) =>
	withStore('readwrite', s => s.put(handle, key)).catch(e => console.warn('Could not remember file handle', e));
export const recallHandle = key => withStore('readonly', s => s.get(key)).catch(() => undefined);
export const forgetHandle = key => withStore('readwrite', s => s.delete(key));

export const isSupported = () => 'showOpenFilePicker' in window;

/** Returns true if we may read and write the file, asking the user if needed. */
export async function ensurePermission(handle, { ask = true } = {}) {
	const opts = { mode: 'readwrite' };
	if ((await handle.queryPermission(opts)) === 'granted') return true;
	return ask && (await handle.requestPermission(opts)) === 'granted';
}

const pawType = { description: 'PAWS language file (*.paw)', accept: { 'application/xml': ['.paw'] } };

export async function pickLanguageToOpen() {
	const [handle] = await window.showOpenFilePicker({ id: 'paws-language', types: [pawType] });
	return handle;
}

export function pickSaveTarget({ suggestedName, description, extension, id }) {
	return window.showSaveFilePicker({
		id,
		suggestedName,
		types: [{ description, accept: { 'text/plain': [extension] } }],
	});
}

export async function readText(handle) {
	return (await handle.getFile()).text();
}

export async function writeText(handle, text) {
	const writable = await handle.createWritable();
	await writable.write(text);
	await writable.close();
}

/** True if the user dismissed a file picker (not an error worth reporting). */
export const isAbort = e => e?.name === 'AbortError';
