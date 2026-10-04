// Connect phone: a one-time pairing code, its QR and the connection link.
import {$, app, notice, api} from './core.mjs';

let pairLink, qrUrl;
function showSettings(show) {
  const dialog = $('settings');
  if (show && !dialog.open) dialog.showModal();
  if (!show && dialog.open) dialog.close();
  $('settings-toggle').setAttribute('aria-expanded', String(show));
}
$('settings-toggle').onclick = () => showSettings(true);
$('settings-close').onclick = () => showSettings(false);
$('settings').addEventListener('close', () => $('settings-toggle').setAttribute('aria-expanded', 'false'));
$('settings').addEventListener('click', event => { if (event.target === $('settings')) showSettings(false); });
$('pair-button').onclick = async () => {
  const button = $('pair-button'); button.disabled = true;
  try {
    const pairing = await api('/pairing'); pairLink = pairing.link;
    $('pair-url').textContent = pairing.url; $('pair-code').textContent = pairing.code;
    const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(pairing.url);
    $('pair-expiry').textContent = local ? 'This is a local address. Configure your private Tailscale HTTPS address before pairing your phone.' : `Expires ${new Date(pairing.expiresAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}. Pairing stays saved after connecting.`;
    $('pair-details').hidden = false; $('pair-qr').hidden = true; button.textContent = 'Create new code';
    if (!local) {
      const response = await fetch(`/api/pairing/qr?code=${encodeURIComponent(pairing.code)}`, {headers:{Authorization:`Bearer ${app.token}`}});
      if (response.ok) { if (qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = URL.createObjectURL(await response.blob()); const qr = new Image(184,184); qr.src = qrUrl; qr.alt = 'Scan to connect PocketBridge on Android'; $('pair-qr').replaceChildren(qr); $('pair-qr').hidden = false; }
      else notice('Pairing code is ready. QR could not load; enter the address and code on your phone.');
    }
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('copy-pair').onclick = async () => { try { await navigator.clipboard.writeText(pairLink); $('copy-pair').textContent = 'Copied'; setTimeout(() => $('copy-pair').textContent = 'Copy connection link',1500); } catch { notice('Clipboard is unavailable. Enter the address and pairing code on your phone.'); } };
