#!/usr/bin/env python3
import asyncio
import json
import os
import sys

import pydantic

from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
from google.antigravity.hooks import hooks, policy
from google.antigravity import types


class Finding(pydantic.BaseModel):
    file: str
    line: int
    severity: str
    category: str
    description: str
    fix: str


class ReviewResult(pydantic.BaseModel):
    findings: list[Finding]


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILLS_PATHS = [
    os.path.join(SCRIPT_DIR, "skills", "security-and-hardening"),
    os.path.join(SCRIPT_DIR, "skills", "code-review-and-quality"),
]

review_policies = [
    policy.deny_all(),
    policy.allow("view_file"),
    policy.allow("list_directory"),
    policy.allow("search_directory"),
    policy.allow("find_file"),
    policy.allow("run_command"),
]

@hooks.post_tool_call
async def log_tool_results(data: types.ToolResult):
    result_str = str(data.result) if data.result else ""
    preview = result_str[:200] + "..." if len(result_str) > 200 else result_str
    print(f"[audit] tool={data.name} result_len={len(result_str)} error={data.error} preview={preview}", flush=True)

@hooks.pre_tool_call_decide
async def enforce_read_only(data: types.ToolCall) -> types.HookResult:
    print(f"[audit] calling tool={data.name} args_keys={list(data.args.keys())}", flush=True)

    if data.name == "run_command":
        cmd = str(data.args.get("CommandLine", ""))
        if not cmd.startswith("git "):
            return types.HookResult(
                allow=False,
                message=f"Only git commands are allowed. Blocked: {cmd}"
            )
    return types.HookResult(allow=True)

async def review_code(target_dir: str) -> dict:
    prompt = f"""Run `git diff main...HEAD` in {target_dir} to get the changes on this branch.
Review ONLY the changed code for security issues.
"""

    config_kwargs = dict(
        system_instructions=(
            "You are a security-focused code review agent. "
            "You review code diffs for vulnerabilities using the loaded skills. "
            "You can run git commands to inspect the diff. "
            "You NEVER modify files."
        ),
        response_schema=ReviewResult,
        skills_paths=SKILLS_PATHS,
        policies=review_policies,
        hooks=[log_tool_results, enforce_read_only],
    )

    if os.environ.get("GEMINI_API_KEY"):
        config_kwargs["api_key"] = os.environ["GEMINI_API_KEY"]
    else:
        config_kwargs["vertex"] = True
        config_kwargs["project"] = os.environ.get("GOOGLE_CLOUD_PROJECT")
        config_kwargs["location"] = os.environ.get("GOOGLE_CLOUD_LOCATION", "global")

    config = LocalAgentConfig(**config_kwargs)

    async with Agent(config) as agent:
        response = await agent.chat(prompt)

        async for token in response:
            sys.stdout.write(token)
            sys.stdout.flush()

        data = await response.structured_output()

        if data and "findings" in data:
            return {"findings": data["findings"]}

        text = await response.text()
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return {"findings": parsed}
            if isinstance(parsed, dict) and "findings" in parsed:
                return {"findings": parsed["findings"]}
        except json.JSONDecodeError:
            pass

    return {"findings": text}


SEVERITY_EMOJI = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🔵"}

def format_markdown(result: dict) -> str:
    findings = result.get("findings", [])
    if isinstance(findings, str):
        return f"## AI Security Review\n\n{findings}\n"
    if not findings:
        return "## AI Security Review\n\nNo security issues found.\n"
    lines = ["## AI Security Review\n"]
    for f in findings:
        emoji = SEVERITY_EMOJI.get(f.get("severity", ""), "⚪")
        lines.append(f"### {emoji} [{f.get('severity', 'unknown').upper()}] {f.get('category', '')}\n")
        lines.append(f"**{f.get('file', '')}:{f.get('line', '')}**\n")
        lines.append(f"{f.get('description', '')}\n")
        lines.append(f"**Fix:** {f.get('fix', '')}\n")
    lines.append("---\n*Powered by Antigravity SDK*")
    return "\n".join(lines)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?", default=".")
    parser.add_argument("--format", choices=["json", "markdown"], default="json")
    args = parser.parse_args()

    result = asyncio.run(review_code(args.target))
    if args.format == "markdown":
        print(format_markdown(result))
    else:
        print(json.dumps(result, indent=2))