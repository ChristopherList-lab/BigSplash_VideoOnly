// The deployed entry point (wrangler.toml main). index.js stays importable by
// plain Node for the tests, so the Workers-only import lives here.
//
// default   the snapshot intake: fetch (the form) and scheduled (the digest)
// LeadDesk  a named entrypoint for the Front Door worker's service binding:
//           await env.DESK.frontDoorLead(lead) -> { clickup: { ok, id?, url? }, slack: { ok } }

import { WorkerEntrypoint } from 'cloudflare:workers';
import worker from './index.js';
import { frontDoorLead } from './desk.js';

export default worker;

export class LeadDesk extends WorkerEntrypoint {
  async frontDoorLead(lead) {
    return frontDoorLead(lead, this.env);
  }
}
