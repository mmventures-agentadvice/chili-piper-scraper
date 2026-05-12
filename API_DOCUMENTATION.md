# Chili Piper Slot Scraper API Documentation

## Overview

The Chili Piper Slot Scraper API provides programmatic access to scrape available meeting slots from Chili Piper forms. The API supports both regular and streaming endpoints for different use cases.

## Base URL

```
https://your-domain.com/api
```

## Authentication

All API endpoints require authentication using Bearer tokens. Include the API key in the Authorization header:

```
Authorization: Bearer your-api-key-here
```

### Getting API Keys

Contact your administrator to obtain an API key. API keys are managed through the admin interface.

## Endpoints

### 1. Get Available Slots (Regular)

**Endpoint:** `POST /api/get-slots`

**Description:** Scrapes available meeting slots and returns all results at once.

**Request Body:**
```json
{
  "first_name": "John",
  "last_name": "Doe", 
  "email": "john.doe@example.com",
  "phone": "5551234567",
  "vendor": "cinq",
  "days": 7
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `first_name`, `last_name`, `email`, `phone` | Yes | Guest details (used for form prefill when vendor uses a form before calendar). |
| `vendor` | No | Chili Piper flow: `cinq` (default) or `luxury-presence`. When omitted, defaults to cinq. For `luxury-presence`, the URL goes directly to the calendar (no form step). The legacy id `luxurypresence` is still accepted. |
| `days` | No | Max days to collect (1–30). Omit for default. |

**Response:**
```json
{
  "success": true,
  "data": {
    "total_slots": 94,
    "total_days": 3,
    "note": "Found 3 days with 94 total booking slots",
    "slots": [
      {
        "date": "Wednesday 29th October  Wed29Oct",
        "time": "1:00 PM",
        "gmt": "GMT-05:00 America/Chicago (CDT)"
      },
      {
        "date": "Wednesday 29th October  Wed29Oct", 
        "time": "1:15 PM",
        "gmt": "GMT-05:00 America/Chicago (CDT)"
      }
    ]
  }
}
```

**Performance:** ~10-15 seconds response time

### 2. Get Available Slots (Streaming)

**Endpoint:** `POST /api/get-slots-per-day-stream`

**Description:** Streams available meeting slots as they are discovered, providing faster initial responses.

**Request Body:** Same as regular endpoint

**Response Format:** Server-Sent Events (SSE)

**Stream Example:**
```
data: {"success":true,"streaming":true,"message":"Starting slot collection...","data":{"total_slots":0,"total_days":0,"slots":[],"note":"Streaming results per day as they become available"}}

data: {"success":true,"streaming":true,"message":"Found 32 slots for Wednesday 29th October","data":{"total_slots":32,"total_days":1,"slots":[{"date":"Wednesday 29th October  Wed29Oct","time":"1:00 PM","gmt":"GMT-05:00 America/Chicago (CDT)"}],"note":"Streaming: 1/7 days collected"}}

data: {"success":true,"streaming":false,"message":"Slot collection completed","data":{"total_slots":94,"total_days":3,"note":"Found 3 days with 94 total booking slots","slots":[...]}}
```

**Performance:** ~4 seconds for first data, complete in ~10-15 seconds

### 3. Book (Unified by Vendor)

**Endpoint:** `POST /api/book`

**Description:** Single booking API that routes to the appropriate vendor based on the `vendor` field. Use this when you want one endpoint for all booking types. Existing endpoints `POST /api/book-slot` (Chili Piper) and `POST /api/book-calendly` (Calendly) remain available for backward compatibility.

| vendor       | Backend              | Required fields (besides vendor, email, firstName, lastName) | Optional |
|-------------|----------------------|----------------------------------------------------------------|----------|
| `cinq`      | Chili Piper          | `dateTime` **or** `date` + `time` (`date`: YYYY-MM-DD; `time`: e.g. 1:25 PM) | `phone`  |
| `luxury-presence` | Chili Piper (direct calendar) | Same as cinq: `dateTime` **or** `date` + `time` | `phone` (form has no phone field) |
| `agentfire` | Calendly (AgentFire) | `date` (YYYY-MM-DD), `time` (e.g. 9:30am)                    | `phone`, `answers` |
| `housejet-ppc` | Calendly (Pay-per-closing) | `date`, `time`                              | `phone`  |

**Request (Chili Piper – vendor cinq):**
```json
{
  "vendor": "cinq",
  "email": "jane@example.com",
  "firstName": "Jane",
  "lastName": "Doe",
  "phone": "5551234567",
  "dateTime": "November 13, 2025 at 1:25 PM CST"
}
```

**Request (Chili Piper – vendor luxury-presence):**  
Uses a direct-to-calendar URL; after slot selection the guest form (first name, last name, email) is filled and "Confirm Meeting" is clicked. Phone is optional.

```json
{
  "vendor": "luxury-presence",
  "email": "jane@example.com",
  "firstName": "Jane",
  "lastName": "Doe",
  "dateTime": "November 13, 2025 at 1:25 PM CST"
}
```

Alternatively, pass **`date`** and **`time`** instead of `dateTime` (if both `dateTime` and `date`/`time` are sent, `dateTime` is used):

```json
{
  "vendor": "luxury-presence",
  "email": "jane@example.com",
  "firstName": "Jane",
  "lastName": "Doe",
  "date": "2025-11-13",
  "time": "1:25 PM"
}
```

**Request (AgentFire Calendly):**
```json
{
  "vendor": "agentfire",
  "date": "2026-02-05",
  "time": "9:30am",
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "phone": "+15551234567"
}
```

**Request (Pay-per-closing Calendly – housejet-ppc):**
```json
{
  "vendor": "housejet-ppc",
  "date": "2026-02-18",
  "time": "1:00pm",
  "firstName": "Ali",
  "lastName": "Syed",
  "email": "erige1234@gmail.com",
  "phone": "15127673628"
}
```

**Optional (server env):** When `BROWSERLESS_API_TOKEN` is set, housejet-ppc booking uses Browserless BQL (stealth) instead of local Playwright. Optional `BROWSERLESS_BQL_URL` overrides the BQL endpoint (default: `https://production-sfo.browserless.io/stealth/bql`). To rotate IP with local Playwright, set `HOUSEJET_PPC_PROXY_SERVER` (e.g. Smartproxy `http://gate.smartproxy.com:7000`) and optionally `HOUSEJET_PPC_PROXY_USERNAME` / `HOUSEJET_PPC_PROXY_PASSWORD`; only the booking context uses the proxy.

**Success Response (200):** Same shape as the underlying endpoint (e.g. `message`, `date`, `time`; for `/api/book` with Calendly vendors, `data.vendor` is also included).

**Error Responses:** Same as the delegated endpoint (`/api/book-slot` or Calendly booking). Use a request timeout of at least **60 seconds** for Calendly vendors.

**Chili Piper booking (`cinq`, `luxury-presence`):** If the exact time is not available, the server tries other **enabled** slots within a configurable ± window: default **30 minutes** for `cinq` and **15 minutes** for `luxury-presence`. Set env `CHILI_SLOT_FALLBACK_WINDOW_MINUTES` to `15` or `30` to override the default for all Chili vendors.

**Chili success JSON (`data`):** `time` is the **booked** wall time. `requestedTime` repeats the time from the request (useful when the booked slot differs after fallback).

**Chili HTTP 203 — slot window exhausted:** Returned when no enabled slot exists within the configured window for the requested day. Response body uses the standard error shape (`success: false`, `code`: `SLOT_WINDOW_EXHAUSTED`) with `error.metadata` including `reason`, `requestedTime`, `requestedDate`, `slotFallbackWindowMinutes`, and `availableSlotsSample`. In this project, **HTTP 203** specifically means “no bookable slot in the fallback window,” not general RFC 203 “non-authoritative information.”

For **`POST /api/book`** with vendor `cinq` or `luxury-presence`, **203** and the JSON body are passed through unchanged (not converted to 200 or 201).

### 4. Book Calendly Slot (AgentFire Demo)

**Endpoint:** `POST /api/book-calendly`

**Description:** Books a Calendly slot. By default this uses the AgentFire demo event (full questionnaire). You can switch to a **simple event** (name, email, and phone only) by setting `CALENDLY_BASE_URL` (e.g. `https://calendly.com/pay-per-closing/exclusive-referral-program-agent-advice`) and optionally `CALENDLY_SIMPLE_FORM=1`. In simple form mode, only `date`, `time`, `firstName`, `lastName`, `email`, and `phone` are used; `answers` is ignored. Confirmation can be tuned with `CALENDLY_CONFIRMATION_URL_REGEX` (e.g. `calendly\.com.*scheduled`); when unset in simple mode, the booker detects success via on-page text (e.g. "You're scheduled"). **Dynamic data:** only `date`, `time`, `firstName`, `lastName`, `email`, and optionally `phone` are required. For the default AgentFire event, all other form questions use fixed default selections unless you override them via `answers`. Uses the same instance-reuse logic as the Chili Piper book-slot (one browser instance per email).

**Minimal Request (dynamic fields only; all other answers use defaults):**
```json
{
  "date": "2026-02-05",
  "time": "6:00am",
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "phone": "+15551234567"
}
```

**Request with optional overrides:** You can pass `answers` to override any default. Keys can be `question_0` … `question_9` or label-based.
```json
{
  "date": "2026-02-04",
  "time": "9:30am",
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "phone": "+15551234567",
  "answers": {
    "question_1": "Custom demo notes.",
    "Current Website URL:": "https://mywebsite.com"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| date | string | Yes | Date in `YYYY-MM-DD` format |
| time | string | Yes | Time slot, e.g. `9:30am` or `2:00 PM` |
| firstName | string | Yes | First name |
| lastName | string | Yes | Last name |
| email | string | Yes | Email address (used for instance reuse) |
| phone | string | No | Phone number (used for Phone Number question; recommended) |
| answers | object | No | Override default answers. If omitted, defaults are used for all questions. Keys: `question_0` … `question_9` or label-based. Single-choice: string; multi-choice: array of strings. |

**Default answers (used when `answers` is omitted or a key is not provided):** question_1: "AgentAdvice booking", question_2: "Agent", question_3: ["Build and strengthen my online brand"], question_4: "www.test.com", question_5: "A 'themed' website design that can be launched quickly", question_6: "N/A", question_7: "AGENTADVICE", question_8: ["Yes of course! "], question_9: "United States". Phone (question_0) is taken from `phone` when provided.

**Label-based answer keys (optional):** You can use these labels instead of `question_N` in `answers`:

- `"Phone Number"` → question_0  
- `"To help us prepare for your demo, please share a bit about yourself and what you're looking for with an AgentFire website."` → question_1  
- `"Which of the following best describes you:"` → question_2  
- `"Which of the following options best describe your goals with an AgentFire website? (Please select all that apply)"` → question_3  
- `"Current Website URL:"` → question_4  
- `"What best describes the type of website design you're looking for?"` → question_5  
- `"MLS Board(s) you belong to:"` → question_6  
- `"How'd you hear about AgentFire? (i.e. Received an Email, Google Search, Facebook Ad, Instagram Ad, Partner / Referral, etc.)"` → question_7  
- `"If something comes up and you need to reschedule, will you let us know ahead of your demo so that we can free up that time for someone else?"` → question_8  
- `"Your Location"` → question_9  

**Success Response (200):**
```json
{
  "success": true,
  "status": 200,
  "code": "OPERATION_SUCCESS",
  "data": {
    "message": "Calendly slot booked successfully",
    "date": "2026-02-04",
    "time": "9:30am"
  },
  "responseTime": 12000,
  "requestId": "req_..."
}
```

**Performance and client timeout:** Booking can take **30–60 seconds** (browser automation, page load, form submit). **Use a request timeout of at least 60 seconds** when calling this endpoint; otherwise you may get client-side timeouts (e.g. "Operation timed out" / code 28) before the server responds.

**Error Responses:**  
- `400` – Validation error (invalid date, time, or answers).  
- `500` – Slot not found, day not available, or form/booking failure.  
- `504` – Request timeout.

### 5. Health Check

**Endpoint:** `GET /api/health`

**Description:** Check if the service is running and healthy.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-10-29T01:56:28.904Z",
  "service": "Chili Piper Slot Scraper (Next.js)",
  "debug": {
    "node_version": "v20.19.5",
    "request_method": "GET",
    "request_url": "http://localhost:3000/api/health"
  }
}
```

## Admin Endpoints

### API Key Management

**Endpoint:** `POST /api/admin/api-keys`

**Description:** Manage API keys (create, update, delete, list)

**Authentication:** Requires admin JWT token

**Actions:**

#### Generate Admin Token
```json
{
  "action": "generate-admin-token"
}
```

#### Create API Key
```json
{
  "action": "create",
  "name": "Client Name",
  "description": "API key for client",
  "customKey": "optional-custom-key"
}
```

#### List API Keys
```json
{
  "action": "list"
}
```

#### Update API Key
```json
{
  "action": "update",
  "id": 1,
  "updates": {
    "name": "Updated Name",
    "is_active": true
  }
}
```

#### Delete API Key
```json
{
  "action": "delete",
  "id": 1
}
```

#### Get Usage Statistics
```json
{
  "action": "stats",
  "apiKeyId": 1
}
```

## Error Responses

### Authentication Error
```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Invalid or missing API key. Please provide a valid Bearer token.",
  "usage": {
    "example": "Authorization: Bearer your-api-key-here"
  }
}
```

### Validation Error
```json
{
  "success": false,
  "error": "Missing required fields",
  "message": "The following fields are required: first_name, last_name"
}
```

### Scraping Error
```json
{
  "success": false,
  "error": "Scraping failed",
  "message": "Could not find calendar elements"
}
```

## Rate Limits

- **Regular API:** No specific rate limits (limited by server resources)
- **Streaming API:** No specific rate limits (limited by server resources)
- **Admin API:** Rate limited to prevent abuse

## Usage Tracking

All API usage is tracked including:
- Request count per API key
- Response times
- Success/failure rates
- IP addresses
- User agents

## Configuration

The scraper can be configured via environment variables:

- `CHILI_PIPER_FORM_URL`: Target Chili Piper form URL
- `MAX_DAYS_TO_COLLECT`: Maximum days to scrape (default: 7)
- `MAX_SCRAPING_TIMEOUT`: Timeout in milliseconds (default: 30000)

## Examples

### JavaScript/Node.js
```javascript
const response = await fetch('https://your-domain.com/api/get-slots', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-api-key-here'
  },
  body: JSON.stringify({
    first_name: 'John',
    last_name: 'Doe',
    email: 'john.doe@example.com',
    phone: '5551234567'
  })
});

const data = await response.json();
console.log(data);
```

### Python
```python
import requests

url = 'https://your-domain.com/api/get-slots'
headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-api-key-here'
}
data = {
    'first_name': 'John',
    'last_name': 'Doe',
    'email': 'john.doe@example.com',
    'phone': '5551234567'
}

response = requests.post(url, json=data, headers=headers)
result = response.json()
print(result)
```

### cURL
```bash
curl -X POST https://your-domain.com/api/get-slots \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-here" \
  -d '{
    "first_name": "John",
    "last_name": "Doe",
    "email": "john.doe@example.com", 
    "phone": "5551234567"
  }'
```

## Support

For technical support or API key requests, contact your system administrator.
