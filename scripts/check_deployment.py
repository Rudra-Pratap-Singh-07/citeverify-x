"""Exercise a running gateway: python scripts/check_deployment.py https://API-HOST."""

from __future__ import annotations

import argparse
import time

import httpx


SCENARIOS = {
    "clean_study": ["SUPPORTED", "SUPPORTED", "SUPPORTED"],
    "exaggerated_claims": ["PARTIALLY_SUPPORTED"],
    "retracted_and_hallucinated": ["RETRACTED", None],
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Backend origin, without /api/v1")
    parser.add_argument("--origin", default="https://citeverify-x.vercel.app")
    args = parser.parse_args()
    with httpx.Client(base_url=args.url.rstrip("/"), timeout=120) as client:
        health = client.get("/api/v1/health")
        health.raise_for_status()
        require(health.json()["status"] == "ok", "Health check failed")
        print(f"API ready; demo_mode={health.json().get('demo_mode', 'unknown')}")
        preflight = client.options(
            "/api/v1/verify",
            headers={
                "Origin": args.origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        preflight.raise_for_status()
        require(
            preflight.headers.get("access-control-allow-origin") == args.origin,
            "Frontend origin is not permitted by the API",
        )
        for scenario, expected in SCENARIOS.items():
            started = time.monotonic()
            response = client.post(f"/api/v1/verify/benchmark/{scenario}")
            response.raise_for_status()
            task_id = response.json()["task_id"]
            deadline = time.monotonic() + 120
            while True:
                report = client.get(f"/api/v1/verify/report/{task_id}")
                report.raise_for_status()
                if report.status_code == 200:
                    break
                require(time.monotonic() < deadline, f"{scenario} timed out")
                time.sleep(0.5)
            body = report.json()
            require(
                [claim["label"] for claim in body["claims"]] == expected,
                f"Unexpected verdicts for {scenario}",
            )
            if scenario == "retracted_and_hallucinated":
                require(
                    body["claims"][-1]["checks"][0]["state"] == "insufficient_evidence",
                    "Fabricated source must stay unassessed",
                )
            for kind in ("document", "certificate"):
                pdf = client.get(f"/api/v1/verify/{kind}/{task_id}")
                pdf.raise_for_status()
                require(pdf.content.startswith(b"%PDF"), f"Invalid {kind} PDF")
            print(f"PASS {scenario}: {time.monotonic() - started:.2f}s")
    print("CORS, benchmark jobs, reports, manuscript PDFs and certificates passed.")


if __name__ == "__main__":
    main()
