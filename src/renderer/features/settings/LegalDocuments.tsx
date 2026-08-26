import { FiExternalLink, FiFileText, FiShield } from 'react-icons/fi';

const EFFECTIVE_DATE = 'August 26, 2026';
const PROJECT_URL = 'https://github.com/StreameeApp/Streamee-app';

type LegalDocumentsProps = {
  onOpenExternal: (url: string) => void;
};

const LegalDocuments = ({ onOpenExternal }: LegalDocumentsProps) => (
  <div className="settings-legal" aria-label="Privacy Policy and Terms of Use">
    <div className="settings-legal-heading">
      <div>
        <h3>Legal</h3>
        <p>Effective {EFFECTIVE_DATE}. These documents describe this version of Streamee.</p>
      </div>
    </div>

    <details className="settings-legal-document">
      <summary>
        <span className="settings-legal-summary-icon"><FiShield aria-hidden="true" /></span>
        <span>
          <strong>Privacy Policy</strong>
          <small>What stays on your device and what is sent to services you use</small>
        </span>
      </summary>
      <div className="settings-legal-body">
        <p><strong>Scope.</strong> This policy covers the Streamee Windows desktop application. Streamee is primarily a local application. It does not require a Streamee user account and does not include advertising or general-purpose usage analytics.</p>

        <h4>Information stored on your device</h4>
        <ul>
          <li>Application settings, metadata-provider API keys, installed add-on records, playback preferences, watchlist, viewing history, episode progress, and resume information.</li>
          <li>Trakt OAuth access and refresh tokens when you connect Trakt. These tokens are kept in the application&apos;s local renderer storage so the connection can persist.</li>
          <li>Configured add-on URLs in Windows Credential Manager. The renderer keeps non-secret installation metadata needed to display and manage those add-ons.</li>
          <li>Disposable or persistent media cache data, downloaded media you choose to keep, generated subtitles, metadata caches, and local diagnostic logs.</li>
        </ul>

        <h4>Information sent over the network</h4>
        <ul>
          <li>Searches, title identifiers, metadata requests, and any API key required by TMDB, OMDb, Trakt, or another metadata service are sent to that service.</li>
          <li>When you connect Trakt, device authorization and token-refresh requests pass through Streamee&apos;s authentication relay and then Trakt. Trakt receives viewing or watchlist data only when you enable or request synchronization.</li>
          <li>Installed add-ons receive the media type and title or episode identifier needed to request available sources. A selected source may then connect to the add-on, media host, playback service, or other endpoint shown by that source.</li>
          <li>Update checks contact the Streamee project&apos;s GitHub release service. Optional metadata, subtitle, segment, or release-information features contact their displayed third-party services when used.</li>
        </ul>

        <h4>Peer-to-peer disclosure</h4>
        <p>When you open a BitTorrent source, Streamee participates in a peer-to-peer swarm. Other peers and discovery infrastructure can see your public IP address, the torrent&apos;s info hash, and normal protocol traffic. While connected, the BitTorrent client may upload pieces you already have to other peers. A VPN or relay may change what address peers see, but Streamee does not provide anonymity.</p>

        <h4>Logs, retention, and deletion</h4>
        <p>Diagnostic logs are written locally and are designed to redact credentials and sensitive URLs. They are not automatically uploaded to the Streamee project; if you share a diagnostic bundle, review it first. Local information remains until you remove it, clear the relevant cache, disconnect a service, use <strong>Delete All Local Data</strong>, or uninstall the application. Files exported or downloaded outside Streamee&apos;s managed data folders may need to be deleted separately.</p>

        <h4>Third parties and security</h4>
        <p>Third-party services process information under their own privacy policies and terms. Streamee cannot control their retention or security practices. No storage or transmission method is completely secure, so protect your Windows account, API keys, tokens, and configured service URLs.</p>

        <h4>Policy changes and questions</h4>
        <p>A future release may update this policy when the application&apos;s behavior changes. The effective date above identifies this version. Questions or privacy reports can be submitted through the public project repository.</p>
        <button className="settings-inline-link settings-legal-link" type="button" onClick={() => onOpenExternal(PROJECT_URL)}>
          Open project repository <FiExternalLink aria-hidden="true" />
        </button>
      </div>
    </details>

    <details className="settings-legal-document">
      <summary>
        <span className="settings-legal-summary-icon"><FiFileText aria-hidden="true" /></span>
        <span>
          <strong>Terms of Use</strong>
          <small>Rules for lawful use of Streamee and user-configured services</small>
        </span>
      </summary>
      <div className="settings-legal-body">
        <p><strong>Acceptance.</strong> By installing or using Streamee, you agree to these Terms of Use. If you do not agree, do not use the application. The application&apos;s source-code license separately governs copying, modification, and distribution of the software.</p>

        <h4>Lawful use</h4>
        <p>Streamee is a general-purpose media player and client for user-configured services. You may use it only with media and services you are legally authorized to access. You are responsible for complying with copyright, communications, privacy, export, and other laws that apply to you. Do not use Streamee to infringe rights, bypass access controls, distribute unlawful material, attack systems, or interfere with networks or other users.</p>

        <h4>Your services and content</h4>
        <p>You choose and configure API keys, accounts, add-ons, source providers, remote streams, local files, and peer-to-peer sources. Streamee does not host or curate their catalogs and does not endorse or verify third-party add-ons or source availability. You are responsible for checking that a service is trustworthy, that its terms allow your intended use, and that you have the necessary rights and permissions.</p>

        <h4>Peer-to-peer use</h4>
        <p>BitTorrent operation can download and upload data and exposes your public IP address to peers. You are responsible for network charges, data usage, source legality, and any sharing performed through your connection. Do not use peer-to-peer features where prohibited by law, contract, network policy, or your internet provider.</p>

        <h4>Third-party services</h4>
        <p>TMDB, OMDb, Trakt, GitHub, installed add-ons, media hosts, external players, and other integrations are independent services with their own terms and privacy policies. Their availability, accuracy, content, and conduct are outside the Streamee project&apos;s control. Streamee is not affiliated with or endorsed by those services unless expressly stated.</p>

        <h4>Updates and availability</h4>
        <p>Features, integrations, and these terms may change as the application evolves. Third-party changes may interrupt functionality. The project may suspend an integration or authentication relay when necessary for security, abuse prevention, legal compliance, or service reliability.</p>

        <h4>Disclaimer</h4>
        <p>To the extent permitted by applicable law, Streamee is provided without warranties of uninterrupted operation, availability, accuracy, fitness for a particular purpose, or non-infringement. You are responsible for backing up important data and evaluating sources before opening them. Nothing in these terms excludes rights or remedies that cannot legally be excluded.</p>

        <h4>Questions</h4>
        <p>Questions about these terms can be submitted through the public project repository.</p>
        <button className="settings-inline-link settings-legal-link" type="button" onClick={() => onOpenExternal(PROJECT_URL)}>
          Open project repository <FiExternalLink aria-hidden="true" />
        </button>
      </div>
    </details>
  </div>
);

export default LegalDocuments;
