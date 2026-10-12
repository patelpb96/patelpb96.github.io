// patelpb.com viewer-request function (cloudfront-js-2.0)
// 1. www.patelpb.com -> 301 https://patelpb.com<path>?<query>
// 2. URI ending in "/"            -> append "index.html" (internal rewrite)
// 3. last segment has no "."      -> 301 to the same URI + "/" so relative
//    links inside subdirectory pages (e.g. /projects/atp/) resolve correctly,
//    matching GitHub Pages behaviour.
function qs(request) {
    var parts = [];
    var q = request.querystring || {};
    for (var key in q) {
        var item = q[key];
        if (item.multiValue) {
            for (var i = 0; i < item.multiValue.length; i++) {
                parts.push(key + (item.multiValue[i].value !== '' ? '=' + item.multiValue[i].value : ''));
            }
        } else {
            parts.push(key + (item.value !== '' ? '=' + item.value : ''));
        }
    }
    return parts.length > 0 ? '?' + parts.join('&') : '';
}

function redirect(location) {
    return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: {
            location: { value: location },
            'cache-control': { value: 'public, max-age=3600' }
        }
    };
}

function handler(event) {
    var request = event.request;
    var host = request.headers.host && request.headers.host.value ? request.headers.host.value.toLowerCase() : '';
    var uri = request.uri;

    if (host === 'www.patelpb.com') {
        return redirect('https://patelpb.com' + uri + qs(request));
    }

    if (uri.endsWith('/')) {
        request.uri = uri + 'index.html';
        return request;
    }

    var last = uri.substring(uri.lastIndexOf('/') + 1);
    if (last.indexOf('.') === -1) {
        return redirect(uri + '/' + qs(request));
    }
    return request;
}
