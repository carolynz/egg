# Privacy Policy

**Last updated: February 20, 2026**

Egg is a personal AI agent built and operated by a single individual for personal use. This policy describes how the Oura integration accesses and uses your data.

## What data is accessed

When the Oura integration is enabled, Egg accesses your Oura Ring sleep data via the Oura API, specifically:

- Sleep session start and end times
- Sleep score and readiness data (to determine wake-up time)

## How data is used

Oura data is used to:

- Detect when you wake up and trigger a personalized good morning message via iMessage
- Inform the AI agent's context and memory for personalized responses
- Support personal health and sleep pattern analysis over time

## Data storage

Oura API responses may be processed in memory or logged locally as part of the agent's operation. Data is not intentionally persisted to external services beyond what is described below.

## Who has access

This is a single-user personal application. Only you (the operator) control the deployment. However, because this is an AI agent, your Oura data — including sleep session data — may be transmitted to AI providers (such as Anthropic) as part of the agent's normal operation. By enabling the Oura integration, you acknowledge and consent to this. This project is open-source, and the data flows are visible in the code.

## Third-party services

- **Oura API**: used to retrieve sleep data. Subject to [Oura's Privacy Policy](https://ouraring.com/privacy-policy).
- **AI providers** (e.g. Anthropic): sleep and health data may be included in prompts sent to AI APIs as part of agent operation. Subject to the respective provider's privacy and data use policies.

## Contact

This is a personal open-source project. For questions, open an issue at the project repository.
