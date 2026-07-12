//! AI-assist commands. The user supplies their own API key in Settings; we
//! dispatch to whichever provider they picked.
//!
//! Providers supported:
//!   - "claude"  → Anthropic Messages API
//!   - "gemini"  → Google AI Studio (generativelanguage.googleapis.com)
//!   - "openai"  → OpenAI Chat Completions
//!
//! The Rust side never logs the API key or echoes it in errors. We trust
//! the provider's HTTPS endpoint; outbound traffic goes only to those three
//! domains.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateArgs {
    pub provider: String,
    pub api_key: String,
    /// Optional override; each provider has a sensible default below.
    pub model: Option<String>,
    /// User's natural-language prompt.
    pub prompt: String,
    /// Optional schema context — the FROM-object name and a sampling of its
    /// fields, so the model can name real columns.
    pub schema_context: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateResult {
    pub soql: String,
    /// Useful for the UI to know which model actually answered (provider may
    /// have defaulted it).
    pub model: String,
}

#[tauri::command]
pub async fn ai_generate_soql(args: AiGenerateArgs) -> Result<AiGenerateResult, AppError> {
    if args.api_key.trim().is_empty() {
        return Err(AppError::CliError(
            "AI API key is not set — add one in Settings.".into(),
        ));
    }
    if args.prompt.trim().is_empty() {
        return Err(AppError::CliError("Prompt is empty.".into()));
    }

    let provider = args.provider.to_lowercase();
    let system_prompt = build_system_prompt(args.schema_context.as_deref());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Io(format!("http client: {e}")))?;

    match provider.as_str() {
        "claude" => {
            call_claude(
                &client,
                &args.api_key,
                args.model.as_deref(),
                &system_prompt,
                &args.prompt,
            )
            .await
        }
        "gemini" => {
            call_gemini(
                &client,
                &args.api_key,
                args.model.as_deref(),
                &system_prompt,
                &args.prompt,
            )
            .await
        }
        "openai" => {
            call_openai(
                &client,
                &args.api_key,
                args.model.as_deref(),
                &system_prompt,
                &args.prompt,
            )
            .await
        }
        other => Err(AppError::CliError(format!(
            "Unknown AI provider '{other}' — use claude, gemini, or openai."
        ))),
    }
}

fn build_system_prompt(schema_context: Option<&str>) -> String {
    let mut s = String::from(
        "You are a SOQL expert for Salesforce. Generate exactly one valid SOQL query that matches the user's request.\n\
         Rules:\n\
         - Output ONLY the SOQL. No markdown fences, no commentary, no explanation.\n\
         - Use real Salesforce field and object names. Don't invent fields.\n\
         - When in doubt, prefer simple, idiomatic queries.\n\
         - Always include LIMIT unless the user explicitly asks for all records.\n",
    );
    if let Some(ctx) = schema_context.filter(|c| !c.trim().is_empty()) {
        s.push_str("\nSchema context:\n");
        s.push_str(ctx);
        s.push('\n');
    }
    s
}

/// Strip any markdown fences or surrounding chatter — defense-in-depth in case
/// a model ignored the instructions.
fn clean_response(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // ```soql ... ``` or ``` ... ```
    if let Some(rest) = s.strip_prefix("```") {
        // Drop everything up to the first newline (e.g. "```soql\n")
        let after_lang = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or(rest);
        s = after_lang.to_string();
        if let Some(idx) = s.rfind("```") {
            s.truncate(idx);
        }
    }
    s.trim().to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider implementations
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_DEFAULT_MODEL: &str = "claude-sonnet-4-5";
const GEMINI_DEFAULT_MODEL: &str = "gemini-2.5-flash";
const OPENAI_DEFAULT_MODEL: &str = "gpt-4o-mini";

async fn call_claude(
    client: &reqwest::Client,
    api_key: &str,
    model_override: Option<&str>,
    system: &str,
    user: &str,
) -> Result<AiGenerateResult, AppError> {
    let model = model_override.unwrap_or(CLAUDE_DEFAULT_MODEL).to_string();
    let body = json!({
        "model": &model,
        "max_tokens": 1024,
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    });
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("Anthropic request failed: {e}")))?;

    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| AppError::ParseError(format!("Anthropic response not JSON: {e}")))?;

    if !status.is_success() {
        let msg = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("(no error message)")
            .to_string();
        return Err(AppError::CliError(format!("Anthropic {status}: {msg}")));
    }

    // content is an array of blocks; we want the first text block's `text`.
    let text = payload
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ParseError("Anthropic response had no content[0].text".into()))?
        .to_string();

    Ok(AiGenerateResult {
        soql: clean_response(&text),
        model,
    })
}

async fn call_gemini(
    client: &reqwest::Client,
    api_key: &str,
    model_override: Option<&str>,
    system: &str,
    user: &str,
) -> Result<AiGenerateResult, AppError> {
    let model = model_override.unwrap_or(GEMINI_DEFAULT_MODEL).to_string();
    // Gemini's chat endpoint uses {model}:generateContent and supports a
    // systemInstruction block in addition to the user contents.
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    );
    let body = json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": user }] }],
        "generationConfig": { "temperature": 0.2, "maxOutputTokens": 1024 },
    });
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("Gemini request failed: {e}")))?;

    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| AppError::ParseError(format!("Gemini response not JSON: {e}")))?;

    if !status.is_success() {
        let msg = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("(no error message)")
            .to_string();
        return Err(AppError::CliError(format!("Gemini {status}: {msg}")));
    }

    let text = payload
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::ParseError(
                "Gemini response had no candidates[0].content.parts[0].text".into(),
            )
        })?
        .to_string();

    Ok(AiGenerateResult {
        soql: clean_response(&text),
        model,
    })
}

async fn call_openai(
    client: &reqwest::Client,
    api_key: &str,
    model_override: Option<&str>,
    system: &str,
    user: &str,
) -> Result<AiGenerateResult, AppError> {
    let model = model_override.unwrap_or(OPENAI_DEFAULT_MODEL).to_string();
    let body = json!({
        "model": &model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("OpenAI request failed: {e}")))?;

    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| AppError::ParseError(format!("OpenAI response not JSON: {e}")))?;

    if !status.is_success() {
        let msg = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("(no error message)")
            .to_string();
        return Err(AppError::CliError(format!("OpenAI {status}: {msg}")));
    }

    let text = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::ParseError("OpenAI response had no choices[0].message.content".into())
        })?
        .to_string();

    Ok(AiGenerateResult {
        soql: clean_response(&text),
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_markdown_fence_with_lang() {
        let raw = "```soql\nSELECT Id FROM Account\n```";
        assert_eq!(clean_response(raw), "SELECT Id FROM Account");
    }

    #[test]
    fn clean_strips_bare_fence() {
        let raw = "```\nSELECT Id FROM Account LIMIT 5\n```";
        assert_eq!(clean_response(raw), "SELECT Id FROM Account LIMIT 5");
    }

    #[test]
    fn clean_no_fence_returns_trimmed() {
        let raw = "  SELECT Id FROM Account\n";
        assert_eq!(clean_response(raw), "SELECT Id FROM Account");
    }
}
