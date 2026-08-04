"""
TAC Handoff Bridge — Langflow Custom Component (generic, reusable).

Hands the conversation to a human in Flex when the LLM brain is a Langflow
flow. Use it in ANY demo/flow that runs on the `langflow` provider and needs
human handoff — set `tool_description` per use case.

WHY A BRIDGE. The Langflow provider can't drive TAC's native handoff (no
action detection). This component calls the TAC app's `GET /internal/handoff`
route, which does the whole thing channel-aware, using TAC's OWN config:
  - voice     → TAC sets session.pendingHandoffData → the ConversationRelay WS
                `end` message redirects the LIVE CALL into the Flow's voice
                trigger WITH data.
  - messaging → TAC does a Studio Executions call → Send-to-Flex.

This component holds ZERO Twilio config — no flow SID, no creds. All handoff
config lives on the TAC instance (env `TWILIO_STUDIO_HANDOFF_FLOW_SID` + API
keys). The component just signals "hand off conversation X, reason Y"; TAC
decides how per channel. That keeps Langflow agnostic and this component
stitch-free.

WHY GET. TACServer 403s any non-GET request without a valid Twilio webhook
signature (a global preHandler that skips GET). So the route is a GET and
params ride the query string.

CONVERSATION ID. TAC sets Langflow's `session_id` to the CO conversationId;
we capture it and pass it to the route.

Bind to Langflow Global Variables:
    - tac_base_url            ← public https URL of the TAC app, e.g.
                                https://<tac-app>.fly.dev  (public https, not
                                `.flycast` — force_https 301-breaks it)
    - internal_handoff_token  ← INTERNAL_HANDOFF_TOKEN (optional; only if set on
                                the TAC app)
"""

from langflow.custom import Component
from langflow.inputs import StrInput, SecretStrInput
from langflow.template import Output
from langflow.field_typing import Tool


class TACHandoffBridge(Component):
    display_name = "TAC Handoff Bridge"
    description = (
        "Hand off to a human in Flex via the TAC app's /internal/handoff route "
        "(channel-aware, all config on TAC). For the Langflow provider path."
    )
    icon = "user-round"
    name = "TACHandoffBridge"

    inputs = [
        StrInput(
            name="tac_base_url",
            display_name="TAC App Base URL",
            required=True,
            info=(
                "Public https URL of the TAC app, e.g. https://<tac-app>.fly.dev. "
                "Calls GET {base}/internal/handoff. Use public https — flycast + "
                "force_https 301-breaks the call."
            ),
        ),
        SecretStrInput(
            name="internal_handoff_token",
            display_name="Internal Handoff Token",
            required=False,
            info="Optional. Must match INTERNAL_HANDOFF_TOKEN on the TAC app if that is set.",
        ),
        StrInput(
            name="tool_name",
            display_name="Tool name",
            value="liveAgentHandoff",
            info="Convention: same name the prompt references.",
        ),
        StrInput(
            name="tool_description",
            display_name="Tool description",
            value=(
                "Hand off to a human agent. Use when: the customer explicitly "
                "asks for a human; the request is outside your scope (needs a "
                "specialist, a decision you are not allowed to make, or a "
                "system action you cannot take); the customer is frustrated or "
                "the matter is urgent; or the topic is regulated/sensitive. "
                "Pass a factual `reason` so the human arrives with context. "
                "OVERRIDE this description per use case with the specific "
                "handoff triggers for your demo."
            ),
        ),
    ]

    outputs = [Output(name="tool", display_name="Tool", method="build_tool")]

    def build_tool(self) -> Tool:
        import requests
        from pydantic import BaseModel, Field
        from langchain_core.tools import StructuredTool

        base_url = (self.tac_base_url or "").rstrip("/")
        token = self.internal_handoff_token or ""

        # TAC sets Langflow's session_id to the CO conversationId. Capture at
        # build time; fall back to a call-time frame walk if late-bound.
        captured_session_id = (
            getattr(self, "session_id", None)
            or getattr(getattr(self, "graph", None), "session_id", None)
        )

        class Input(BaseModel):
            customer_phone: str = Field(description="Customer address in E.164 or whatsapp:+... form.")
            customer_name: str = Field(description="Customer name (from memory).")
            reason: str = Field(
                description=(
                    "Factual reason for the handoff, no interpretation, so "
                    "the human arrives with context."
                )
            )

        def run(customer_phone: str, customer_name: str, reason: str) -> str:
            conversation_id = captured_session_id
            if not conversation_id:
                try:
                    import inspect
                    frame = inspect.currentframe()
                    while frame:
                        cid = frame.f_locals.get("session_id")
                        if cid:
                            conversation_id = cid
                            break
                        frame = frame.f_back
                except Exception:
                    pass

            if not conversation_id:
                return (
                    "Error: conversationId unavailable for handoff. "
                    "Tell the customer there was a problem and to try again."
                )
            if not base_url:
                return (
                    "Config error: TAC_BASE_URL is not set on the handoff component. "
                    "Tell the customer there was a problem and to try again."
                )

            params = {
                "conversationId": conversation_id,
                "reason": reason,
                "customer_phone": customer_phone,
                "customer_name": customer_name,
            }
            if token:
                params["token"] = token

            try:
                resp = requests.get(f"{base_url}/internal/handoff", params=params, timeout=10)
            except requests.exceptions.RequestException as e:
                return (
                    f"Network error triggering handoff: {e}. Tell the customer "
                    "there was a problem and to try again in a few minutes."
                )
            if not resp.ok:
                return (
                    f"Error {resp.status_code} triggering handoff: {resp.text}. "
                    "Tell the customer there was a problem with the transfer."
                )

            # TAC did the channel-aware dispatch (voice armed, or messaging
            # executed). Either way, say ONE short transfer line.
            return (
                "Handoff triggered. Say ONE short line confirming the transfer "
                "to the human team and do NOT continue the conversation."
            )

        return StructuredTool.from_function(
            name=self.tool_name,
            description=self.tool_description,
            func=run,
            args_schema=Input,
        )
