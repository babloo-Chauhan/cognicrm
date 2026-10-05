import { CapabilityError } from '../../lib/errors.js';

/**
 * Capability flags. Features are only offered in the UI / API when the active provider
 * declares support — never assume every provider supports every feature.
 */
export const CAPABILITIES = [
  'outboundCall', 'inboundCall', 'webrtc', 'mute', 'hold', 'transferBlind', 'transferWarm', 'conference',
  'dtmf', 'recording', 'recordingDelete', 'monitorListen', 'monitorWhisper', 'monitorBarge', 'numberProvisioning',
  'ivr', 'queueDispatch', 'speechGather', 'redirect',
];

/**
 * Base class / interface every telephony adapter implements.
 *
 * CRM logic never talks to a provider API directly — it calls these methods. Adapters translate
 * them into provider REST calls and translate provider webhooks back into normalized events
 * (see ./events.js). The provider-neutral "actions" DSL (say/play/gather/dial/conference/record/...)
 * is rendered to provider markup (TwiML, Plivo XML, ...) by `renderResponse`.
 */
export class TelephonyProvider {
  /** @param {{ credentials: object, config?: object }} options */
  constructor(name, { credentials = {}, config = {} } = {}) {
    this.name = name;
    this.credentials = credentials;
    this.config = config;
  }

  /** @returns {Record<string, boolean>} */
  get capabilities() {
    return {};
  }

  supports(capability) {
    return Boolean(this.capabilities[capability]);
  }

  require(capability) {
    if (!this.supports(capability)) throw new CapabilityError(this.name, capability);
  }

  unsupported(capability) {
    throw new CapabilityError(this.name, capability);
  }

  // ------------------------------------------------------------ call control
  /**
   * Starts an outbound call. Implementations ring the agent first (WebRTC client or phone) and
   * connect the customer once the agent answers.
   * @param {{ call, agentTarget: string, customerNumber: string, callerId: string, record: boolean, consentText?: string, language?: string }} params
   * @returns {Promise<{ providerCallId: string, legs: Array<{ role: string, providerCallId: string, target: string }> }>}
   */
  async makeCall() { return this.unsupported('outboundCall'); }

  /** Dials the customer into an outbound call after the agent leg answered. */
  async dialCustomer() { return this.unsupported('outboundCall'); }

  /** Places an automated call whose instructions come from `url` (AI voice agent outbound calls). */
  async makeAutomatedCall() { return this.unsupported('speechGather'); }

  /** Rings an agent and connects them to a waiting (queued) call. */
  async connectAgent() { return this.unsupported('queueDispatch'); }

  async hangup() { return this.unsupported('outboundCall'); }

  async hold() { return this.unsupported('hold'); }

  async resume() { return this.unsupported('hold'); }

  async mute() { return this.unsupported('mute'); }

  /** @param {{ type: 'blind'|'warm'|'consult', phase: 'start'|'complete'|'cancel', target }} params */
  async transfer() { return this.unsupported('transferBlind'); }

  /** Adds a participant (three-way / conference room). */
  async conference() { return this.unsupported('conference'); }

  async sendDTMF() { return this.unsupported('dtmf'); }

  /** Supervisor listen / whisper / barge. */
  async monitor() { return this.unsupported('monitorListen'); }

  /** Moves a live call to a new instruction URL (used for queue overflow, fallback, escalation). */
  async redirectCall() { return this.unsupported('redirect'); }

  async getCall() { return this.unsupported('outboundCall'); }

  async getCallStatus(providerCallId) {
    const call = await this.getCall(providerCallId);
    return call?.status;
  }

  // ------------------------------------------------------------ recordings
  async getRecording() { return this.unsupported('recording'); }

  /** Returns a fetch Response streaming the recording audio (credentials stay server-side). */
  async fetchRecordingMedia() { return this.unsupported('recording'); }

  async deleteRecording() { return this.unsupported('recordingDelete'); }

  // ------------------------------------------------------------ numbers
  async searchNumbers() { return this.unsupported('numberProvisioning'); }

  async createNumber() { return this.unsupported('numberProvisioning'); }

  async releaseNumber() { return this.unsupported('numberProvisioning'); }

  async configureWebhook() { return this.unsupported('numberProvisioning'); }

  // ------------------------------------------------------------ browser softphone
  /** Short-lived token for the provider's WebRTC SDK. */
  async createClientToken() { return this.unsupported('webrtc'); }

  /** Identity string the provider uses to ring an agent's browser softphone. */
  clientTarget(userId) { return `client:agent_${userId}`; }

  // ------------------------------------------------------------ webhooks
  /** @returns {boolean} true when the webhook signature is valid */
  validateWebhook() { return false; }

  /**
   * Converts a provider webhook into a normalized event (see events.js).
   * @returns {{ type: string, providerCallId?: string, status?: string, leg?: string, ... } | null}
   */
  parseWebhook() { return null; }

  /**
   * Renders the provider-neutral action list into the provider's response format.
   * @returns {{ contentType: string, body: string }}
   */
  renderResponse() { return this.unsupported('ivr'); }
}
