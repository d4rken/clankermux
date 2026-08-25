/**
 * A REAL ChatGPT/Codex backend SSE stream for a non-streaming `/v1/responses`
 * request, captured live on 2026-08-25 and scrubbed: the response id, the item
 * id, `prompt_cache_key` and `safety_identifier` are replaced with synthetic
 * values. Everything else — event order, field set, and the empty `output`
 * array on the terminal envelope — is verbatim.
 *
 * Keeping it whole is the point: the terminal `response.completed` envelope
 * carries `"output": []`, while the assistant message exists only in the
 * preceding `response.output_item.done` event. That is the divergence from the
 * public OpenAI Responses shape which native-nonstream.ts has to repair, and a
 * hand-written fixture would have encoded the assumption instead of the fact.
 */
export const REAL_CODEX_NONSTREAM_SSE = `event: response.created
data: {"type":"response.created","response":{"id":"resp_fixture0000000000000000000000000000000000000000000","object":"response","created_at":1787642307,"status":"in_progress","background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-5.6-sol","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"00000000-0000-4000-8000-000000000000","prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"medium","mode":"standard","summary":null},"safety_identifier":"user-000000000000000000000000","service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":0}

event: response.in_progress
data: {"type":"response.in_progress","response":{"id":"resp_fixture0000000000000000000000000000000000000000000","object":"response","created_at":1787642307,"status":"in_progress","background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-5.6-sol","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"00000000-0000-4000-8000-000000000000","prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"medium","mode":"standard","summary":null},"safety_identifier":"user-000000000000000000000000","service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":1}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"msg_fixture0000000000000000000000000000000000000000000","type":"message","status":"in_progress","content":[],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":2}

event: response.content_part.added
data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_fixture0000000000000000000000000000000000000000000","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}

event: response.output_text.delta
data: {"type":"response.output_text.delta","content_index":0,"delta":"ok","item_id":"msg_fixture0000000000000000000000000000000000000000000","logprobs":[],"obfuscation":"NiAofjlFu935dw","output_index":0,"sequence_number":4}

event: response.output_text.done
data: {"type":"response.output_text.done","content_index":0,"item_id":"msg_fixture0000000000000000000000000000000000000000000","logprobs":[],"output_index":0,"sequence_number":5,"text":"ok"}

event: response.content_part.done
data: {"type":"response.content_part.done","content_index":0,"item_id":"msg_fixture0000000000000000000000000000000000000000000","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"ok"},"sequence_number":6}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"msg_fixture0000000000000000000000000000000000000000000","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"ok"}],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":7}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_fixture0000000000000000000000000000000000000000000","object":"response","created_at":1787642307,"status":"completed","background":false,"completed_at":1787642308,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-5.6-sol","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"00000000-0000-4000-8000-000000000000","prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"medium","mode":"standard","summary":null},"safety_identifier":"user-000000000000000000000000","service_tier":"default","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":{"input_tokens":13,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":18},"user":null,"metadata":{}},"sequence_number":8}

`;
