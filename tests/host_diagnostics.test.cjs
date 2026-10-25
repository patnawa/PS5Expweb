const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../diagnostics/host.js'), 'utf8');

function boot({fail = false, storageError = false, previous = []} = {}) {
    const elements = Object.fromEntries(['log', 'status', 'run', 'export', 'clear', 'storage']
        .map(id => [id, {value:'', textContent:''}]));
    const entries = new Map([['ps5expweb-host-diagnostics-v1', JSON.stringify(previous)]]);
    const requests = [];
    const storage = {
        getItem: key => { if (storageError) throw Error('Storage blocked'); return entries.get(key); },
        setItem: (key, value) => { if (storageError) throw Error('Storage blocked'); entries.set(key, value); },
        removeItem: key => entries.delete(key)
    };
    class Request {
        open(method, url) { requests.push({method, url}); this.url = url; }
        getResponseHeader() { return this.url.endsWith('.html') ? 'text/html' : this.url.endsWith('.appcache3') ? 'text/cache-manifest' : 'application/javascript'; }
        send() {
            if (fail) { this.ontimeout(); return; }
            this.status = 200;
            this.onload();
        }
    }
    vm.runInNewContext(source, {
        document:{getElementById: id => elements[id]},
        window:{addEventListener() {}},
        localStorage:storage,
        navigator:{userAgent:'test browser', onLine:true},
        XMLHttpRequest:Request,
        Date, Promise, Array, JSON, setTimeout
    });
    return {elements, requests, entries};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('checks only file headers and retains timestamped history', async () => {
    const app = boot({previous:['previous session']});
    assert.equal(app.requests.length, 0, 'checks must require a click');
    app.elements.run.onclick();
    await settle();
    assert.equal(app.requests.length, 2);
    assert.ok(app.requests.every(request => request.method === 'HEAD'));
    assert.match(app.elements.status.textContent, /Host files reachable/);
    assert.match(app.elements.log.value, /^previous session\n\d{4}-/);
    assert.ok(JSON.parse(app.entries.values().next().value).length > 5);
    assert.equal(app.elements.run.disabled, false);
    app.elements.clear.onclick();
    assert.equal(app.elements.log.value, '');
    assert.equal(app.entries.size, 0);
});

test('timeouts produce failure and re-enable checks', async () => {
    const app = boot({fail:true});
    app.elements.run.onclick();
    await settle();
    assert.match(app.elements.status.textContent, /Host check failed/);
    assert.match(app.elements.log.value, /timeout/);
    assert.equal(app.elements.run.disabled, false);
});

test('blocked storage does not prevent checks or visible logging', async () => {
    const app = boot({storageError:true});
    app.elements.run.onclick();
    await settle();
    assert.match(app.elements.storage.textContent, /only in memory/);
    assert.match(app.elements.log.value, /PASS/);
    assert.equal(app.elements.run.disabled, false);
});
