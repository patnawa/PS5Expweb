function get_appcache_state() {
    var appCache = window.applicationCache;

    switch (appCache.status) {
        case appCache.UNCACHED: // UNCACHED == 0
            return 'UNCACHED';
        case appCache.IDLE: // IDLE == 1
            return 'IDLE';
        case appCache.CHECKING: // CHECKING == 2
            return 'CHECKING';
        case appCache.DOWNLOADING: // DOWNLOADING == 3
            return 'DOWNLOADING';
        case appCache.UPDATEREADY: // UPDATEREADY == 4
            return 'UPDATEREADY';
        case appCache.OBSOLETE: // OBSOLETE == 5
            return 'OBSOLETE';
        default:
            return 'UNKNOWN CACHE STATUS';
    }
}

function add_cache_event_toasts() {
    var appCache = window.applicationCache;


    if (!appCache) {
        if (typeof showToast === "function") {
            showToast('★ Not supported', 4000);
        }
        return;
    }

    if (!navigator.onLine) {
        //showToast('★ Offline', 300000);
    }

    appCache.addEventListener('checking', function (e) {
        //showToast('★ Checking cache...');
    }, false);

    appCache.addEventListener('downloading', function (e) {
        showToast('★ Download cache...');
    }, false);

    appCache.addEventListener('cached', function (e) {

        setTimeout(function () {
            showToast('★ Successfully ! ㋡');
        }, 1000);
    }, false);

    appCache.addEventListener('noupdate', function (e) {
        showToast('★ Offline Ready!');
    }, false);

    appCache.addEventListener('obsolete', function (e) {
        showToast('Clear cache & restart');
    }, false);

    appCache.addEventListener('error', function (e) {
        showToast('★ Cache error — offline assets may be incomplete');
    }, false);

    appCache.addEventListener('updateready', function (e) {
        if (window.applicationCache.status != window.applicationCache.UPDATEREADY)
            return;

        // The settle gate (__appcacheSettled) owns the reload while it is
        // waiting for exactly this event; two reload paths would race.
        if (window.__appcacheSettling)
            return;

        // A reload re-runs the page from the top. If an exploit chain has
        // already started -- or already finished -- that reload would arm a
        // second chain against a kernel that is already patched, which is the
        // double-patch that panics the console. Only auto-reload while the
        // page is still idle; otherwise tell the user to reboot so the next
        // launch picks up the new cache.
        if (window.__exploitRunning || window.__exploitDone) {
            showToast('★ Update ready — reboot the console to load it', 12000);
            return;
        }

        // Guard against a manifest that keeps flapping: at most two reloads
        // per browser session, then just notify.
        var KEY = 'ps5expweb_cache_reloads';
        var reloads = 0;
        try {
            reloads = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0;
        } catch (e) {
            reloads = 0;
        }
        if (reloads >= 2) {
            showToast('★ Update ready — refresh manually', 12000);
            return;
        }
        try {
            sessionStorage.setItem(KEY, String(reloads + 1));
        } catch (e) {}

        try {
            window.applicationCache.swapCache();
        } catch (e) {}

        showToast('★ Site updated — reloading to the new build', 3000);
        setTimeout(function () {
            window.location.reload();
        }, 900);
    }, false);
}

// The exploit runner sets these so the cache handler knows when a reload is
// unsafe. Kept on window so the classic script and the module graph agree.
window.__exploitRunning = false;
window.__exploitDone = false;

// Resolves once no appcache update is in flight, so the exploit never starts
// against a cache that is about to be replaced. While an update downloads,
// AppCache serves the OLD copy of every listed file -- payloads included --
// so a chain that starts mid-update would run stale code while the network
// already has the fix. Outcomes:
//   "current"     cache is up to date (or absent), safe to run
//   "cached"      a first download finished, safe to run
//   "unsupported" no applicationCache in this webview, safe to run
//   "error"       cache check failed, safe to run (payloads come from network)
//   "timeout"     check took too long but is no longer downloading, safe to run
//   "stale"       still CHECKING/DOWNLOADING at timeout: NOT safe to run
// An update that lands while waiting makes the page reload itself instead of
// resolving: this helper is only ever awaited before the chain starts, so the
// page is idle and a reload is safe. The promise then never settles on the
// old page.
//
// The grace window is what makes this safe on a cold load. The manifest check
// is asynchronous: when site.js runs, status can still read UNCACHED or IDLE
// even though an update is about to start. Returning "current" there started
// the chain just as the download began -- the exact stale-download freeze. So
// when a manifest is declared and the cache is not yet reporting an update, we
// wait briefly for CHECKING/DOWNLOADING to announce itself before deciding.
var APPCACHE_GRACE_MS = 1500;

window.__appcacheSettled = function () {
    var appCache = window.applicationCache;
    if (!appCache) return Promise.resolve("unsupported");

    var hasManifest = !!document.documentElement.getAttribute("manifest");
    if (!hasManifest) return Promise.resolve("current");

    function waitForOutcome() {
        window.__appcacheSettling = true;
        return new Promise(function (resolve) {
            var settled = false;
            var graceTimer = null;
            var timeoutTimer = null;

            function cleanup() {
                window.__appcacheSettling = false;
                appCache.removeEventListener('updateready', onUpdateReady);
                appCache.removeEventListener('noupdate', onNoUpdate);
                appCache.removeEventListener('cached', onCached);
                appCache.removeEventListener('error', onError);
                appCache.removeEventListener('checking', onChecking);
                appCache.removeEventListener('downloading', onDownloading);
                if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
                if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            }
            function settle(result) {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(result);
            }
            function onUpdateReady() {
                if (appCache.status !== appCache.UPDATEREADY) return;
                cleanup();
                swapAndReload();
                // Never resolves: the page reloads with the new cache.
            }
            function onNoUpdate() { settle("current"); }
            function onCached() { settle("cached"); }
            function onError() { settle("error"); }
            function armTimeout() {
                if (timeoutTimer) return;
                timeoutTimer = setTimeout(function () {
                    // If the update is STILL running, starting the chain would
                    // run it against a cache being replaced. Stop instead.
                    var st = appCache.status;
                    if (st === appCache.CHECKING || st === appCache.DOWNLOADING)
                        settle("stale");
                    else
                        settle("timeout");
                }, 20000);
            }
            function onChecking() { armTimeout(); }
            function onDownloading() { armTimeout(); }

            appCache.addEventListener('updateready', onUpdateReady, false);
            appCache.addEventListener('noupdate', onNoUpdate, false);
            appCache.addEventListener('cached', onCached, false);
            appCache.addEventListener('error', onError, false);
            appCache.addEventListener('checking', onChecking, false);
            appCache.addEventListener('downloading', onDownloading, false);

            var st = appCache.status;
            if (st === appCache.UPDATEREADY) {
                cleanup();
                swapAndReload();
                return;
            }
            if (st === appCache.CHECKING || st === appCache.DOWNLOADING) {
                armTimeout();
                return;
            }
            // Cold load: wait for the check to announce itself.
            graceTimer = setTimeout(function () {
                graceTimer = null;
                var now = appCache.status;
                if (now === appCache.CHECKING || now === appCache.DOWNLOADING) {
                    armTimeout();
                } else {
                    settle("current");
                }
            }, APPCACHE_GRACE_MS);
        });
    }

    if (appCache.status === appCache.UPDATEREADY) {
        swapAndReload();
        return new Promise(function () {});
    }
    return waitForOutcome();
};

function swapAndReload() {
    try {
        window.applicationCache.swapCache();
    } catch (e) {}
    setTimeout(function () {
        window.location.reload();
    }, 300);
}
