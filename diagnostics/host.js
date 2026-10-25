(function () {
    'use strict';
    var key = 'ps5expweb-host-diagnostics-v1';
    var output = document.getElementById('log');
    var status = document.getElementById('status');
    var runButton = document.getElementById('run');
    var lines = [];
    try {
        var stored = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(stored)) {
            lines = stored.filter(function (line) { return typeof line === 'string'; }).slice(-500);
        }
    } catch (error) {
        document.getElementById('storage').textContent = 'Previous log unavailable: ' + error.message;
    }
    function render() {
        output.value = lines.join('\n');
        output.scrollTop = output.scrollHeight;
    }
    function log(message) {
        lines.push(new Date().toISOString() + ' ' + String(message));
        lines = lines.slice(-500);
        render();
        try { localStorage.setItem(key, JSON.stringify(lines)); }
        catch (error) {
            document.getElementById('storage').textContent = 'Log is only in memory: ' + error.message;
        }
    }
    function checkFile(path, expectedType) {
        return new Promise(function (resolve) {
            var request = new XMLHttpRequest();
            request.open('HEAD', './' + path, true);
            request.timeout = 8000;
            request.onload = function () {
                var mime = (request.getResponseHeader('Content-Type') || '').split(';')[0].trim();
                var ok = request.status === 200 && expectedType.indexOf(mime) !== -1;
                log((ok ? 'PASS ' : 'FAIL ') + path + ': HTTP ' + request.status + ', MIME ' + (mime || '(missing)'));
                resolve(ok);
            };
            request.onerror = function () { log('FAIL ' + path + ': network error'); resolve(false); };
            request.ontimeout = function () { log('FAIL ' + path + ': timeout'); resolve(false); };
            request.send();
        });
    }
    window.addEventListener('error', function (event) { log('Page error: ' + event.message); });
    window.addEventListener('unhandledrejection', function (event) { log('Promise error: ' + String(event.reason)); });
    window.addEventListener('online', function () { log('Browser reports online'); });
    window.addEventListener('offline', function () { log('Browser reports offline'); });
    runButton.onclick = function () {
        runButton.disabled = true;
        status.textContent = 'Checking host files…';
        log('Begin host checks; user agent: ' + navigator.userAgent);
        log('Browser online flag: ' + navigator.onLine + ' (does not prove connectivity)');
        log('Application Cache API: ' + (window.applicationCache ? 'available; status ' + window.applicationCache.status : 'unavailable'));
        Promise.all([
            checkFile('index.html', ['text/html']),
            checkFile('host.js', ['application/javascript', 'text/javascript'])
        ]).then(function (results) {
            var passed = results.every(function (ok) { return ok; });
            status.textContent = passed ? 'Host files reachable. Console stability remains untested.' : 'Host check failed. See log for details.';
            log(status.textContent);
            runButton.disabled = false;
        }).catch(function (error) {
            log('Check failed: ' + error.message);
            status.textContent = 'Checks interrupted. See log.';
            runButton.disabled = false;
        });
    };
    document.getElementById('export').onclick = function () {
        var url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], {type:'text/plain'}));
        var link = document.createElement('a');
        link.href = url;
        link.download = 'ps5expweb-host-log.txt';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        status.textContent = 'Export requested. If downloads are unavailable, select and copy the log text.';
    };
    document.getElementById('clear').onclick = function () {
        lines = [];
        try { localStorage.removeItem(key); } catch (error) { /* In-memory clear still works. */ }
        render();
        status.textContent = 'Log cleared.';
    };
    render();
})();
