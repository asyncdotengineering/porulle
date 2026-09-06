---
"@porulle/core": minor
---

Routes can declare what they return. `RouteChain.output(schema)` fills the `data` slot of the success envelope in the generated OpenAPI document, so `openapi-typescript` emits a real type instead of `data?: unknown` for every route in the app. Routes that do not call it generate exactly what they generated before. The schema documents the response; it does not validate the handler's return.
