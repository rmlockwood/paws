// Minimal static server for the PAWS web proof of concept.
//   node web/serve.mjs            -> http://localhost:8080/
//   PORT=9000 node web/serve.mjs
//
// Serves this folder at "/" and the repo's resources folder at "/resources/".
// Lookups fall back to a case-insensitive match, because the HTML pages were
// written for Windows (e.g. a link to "purpose_en.htm" for "Purpose_en.htm").
// The File System Access API needs a secure context; http://localhost counts.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mounts = [
	['/resources/', path.resolve(here, '../resources')],
	['/testdata/', path.resolve(here, '../test/org/sil/paws/testdata')], // used by test/selftest.html
	['/', here],
];
const port = Number(process.env.PORT) || 8080;

const types = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.xml': 'application/xml',
	'.xsl': 'application/xml',
	'.dtd': 'application/xml-dtd',
	'.paw': 'application/xml',
	'.properties': 'text/plain',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
};

async function resolveCaseInsensitive(root, rel) {
	let current = root;
	for (const segment of rel.split('/').filter(Boolean)) {
		const exact = path.join(current, segment);
		try {
			await fs.access(exact);
			current = exact;
			continue;
		} catch { /* fall through to case-insensitive match */ }
		const entries = await fs.readdir(current).catch(() => []);
		const match = entries.find(e => e.toLowerCase() === segment.toLowerCase());
		if (!match) return null;
		current = path.join(current, match);
	}
	return current;
}

http.createServer(async (req, res) => {
	try {
		const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		const [prefix, root] = mounts.find(([p]) => urlPath.startsWith(p));
		let file = await resolveCaseInsensitive(root, urlPath.slice(prefix.length));
		if (file && !file.startsWith(root)) file = null; // no path traversal
		if (file && (await fs.stat(file)).isDirectory()) {
			const index = path.join(file, 'index.html');
			if (!(await fs.access(index).then(() => true, () => false))) {
				// Directory listing as JSON (the self-test uses it to find every page description).
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await fs.readdir(file)));
				return;
			}
			file = index;
		}
		const body = file ? await fs.readFile(file).catch(() => null) : null;
		if (!body) {
			res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + urlPath);
			return;
		}
		res.writeHead(200, {
			'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
			'Cache-Control': 'no-cache',
		}).end(body);
	} catch (e) {
		res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e));
	}
}).listen(port, '127.0.0.1', () => {
	console.log(`PAWS web proof of concept: http://localhost:${port}/`);
});
