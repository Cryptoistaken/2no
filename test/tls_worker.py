import sys, json, tls_client

session = tls_client.Session(
    client_identifier="chrome_120",
    random_tls_extension_order=True
)

base_headers = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-gpc": "1",
    "referer": "https://2nd-no.com/",
    "origin": "https://2nd-no.com/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

for line in sys.stdin:
    req = None
    try:
        req = json.loads(line.strip())
        headers = {**base_headers, **req.get("headers", {})}
        body = req.get("body", {})

        proxy = req.get("proxy")
        if proxy:
            session.proxies = {"http": proxy, "https": proxy}
        else:
            session.proxies = {}

        method = req.get("method", "POST").upper()
        url = req.get("url", "https://2no.pl/")

        if method == "GET":
            resp = session.get(url, headers=headers, timeout_seconds=req.get("timeout", 30))
        elif method == "POST":
            resp = session.post(url, json=body, headers=headers, timeout_seconds=req.get("timeout", 30))
        else:
            raise ValueError(f"Unsupported method: {method}")

        print(json.dumps({
            "id": req.get("id"),
            "status": resp.status_code,
            "headers": dict(resp.headers),
            "body": resp.text
        }, ensure_ascii=False), flush=True)
    except Exception as e:
        rid = req.get("id") if req else None
        print(json.dumps({"id": rid, "error": str(e)}, ensure_ascii=False), flush=True)
