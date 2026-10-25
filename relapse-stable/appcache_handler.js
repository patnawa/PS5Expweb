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
//   "current"     cache is up to date, safe to run
//   "unsupported" no applicationCache in this webview, safe to run
//   "error"       cache check failed, safe to run (payloads come from network)
//   "timeout"     check took too long, safe to run
// An update that lands while waiting makes the page reload itself instead of
// resolving: this helper is only ever awaited before the chain starts, so the
// page is idle and a reload is safe. The promise then never settles on the
// old page.
window.__appcacheSettled = function () {
    var appCache = window.applicationCache;
    if (!appCache) return Promise.resolve("unsupported");

    if (
        appCache.status === appCache.UNCACHED ||
        appCache.status === appCache.IDLE ||
        appCache.status === appCache.OBSOLETE
    ) return Promise.resolve("current");

    if (appCache.status === appCache.UPDATEREADY) {
        swapAndReload();
        return new Promise(function () {});
    }

    // CHECKING or DOWNLOADING: wait for the outcome, bounded.
    window.__appcacheSettling = true;
    return new Promise(function (resolve) {
        var settled = false;
        function cleanup() {
            window.__appcacheSettling = false;
            appCache.removeEventListener('updateready', onUpdateReady);
            appCache.removeEventListener('noupdate', onNoUpdate);
            appCache.removeEventListener('error', onError);
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
        function onError() { settle("error"); }

        appCache.addEventListener('updateready', onUpdateReady, false);
        appCache.addEventListener('noupdate', onNoUpdate, false);
        appCache.addEventListener('error', onError, false);
        // A stuck check must never hold the console hostage: the payloads are
        // fetched from the network now, so continuing is always safe.
        setTimeout(function () { settle("timeout"); }, 20000);
    });
};

function swapAndReload() {
    try {
        window.applicationCache.swapCache();
    } catch (e) {}
    setTimeout(function () {
        window.location.reload();
    }, 300);
}
