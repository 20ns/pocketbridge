// Connect phone: a one-time pairing code, its QR and the connection link, and the phones already paired.
import {$, el, app, notice, api} from './core.mjs';
import {relativeTime} from './support.mjs';

let pairLink, qrUrl;
function showSettings(show) {
  const dialog = $('settings');
  if (show && !dialog.open) dialog.showModal();
  if (!show && dialog.open) dialog.close();
  $('settings-toggle').setAttribute('aria-expanded', String(show));
}
$('settings-toggle').onclick = () => { showSettings(true); loadPhones(); };
$('settings-close').onclick = () => showSettings(false);
$('settings').addEventListener('close', () => $('settings-toggle').setAttribute('aria-expanded', 'false'));
$('settings').addEventListener('click', event => { if (event.target === $('settings')) showSettings(false); });
$('pair-button').onclick = async () => {
  const button = $('pair-button'); button.disabled = true;
  try {
    const pairing = await api('/pairing'); pairLink = pairing.link;
    $('pair-url').textContent = pairing.url; $('pair-code').textContent = pairing.code;
    const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(pairing.url);
    $('pair-expiry').textContent = local ? 'This is a local address. Run Setup phone connection on this Mac before pairing your phone.' : `Expires ${new Date(pairing.expiresAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}. Pairing stays saved after connecting.`;
    $('pair-details').hidden = false; $('pair-qr').hidden = true; button.textContent = 'Create new code';
    if (!local) {
      const response = await fetch(`/api/pairing/qr?code=${encodeURIComponent(pairing.code)}`, {headers:{Authorization:`Bearer ${app.token}`}});
      if (response.ok) { if (qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = URL.createObjectURL(await response.blob()); const qr = new Image(184,184); qr.src = qrUrl; qr.alt = 'Scan to connect Felva on Android'; $('pair-qr').replaceChildren(qr); $('pair-qr').hidden = false; }
      else notice('Pairing code is ready. QR could not load; enter the address and code on your phone.');
    }
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('copy-pair').onclick = async () => { try { await navigator.clipboard.writeText(pairLink); $('copy-pair').textContent = 'Copied'; setTimeout(() => $('copy-pair').textContent = 'Copy connection link',1500); } catch { notice('Clipboard is unavailable. Enter the address and pairing code on your phone.'); } };

/** Paired phones, newest first. Refreshed when the dialog opens and on each change the Mac reports while it is open. */
export async function loadPhones() {
  if (!$('settings').open || !app.token) return;
  let devices;
  try { ({devices} = await api('/devices')); } catch (error) { notice(error.message); return; }
  $('phones-empty').hidden = devices.length > 0;
  $('phones').replaceChildren(...devices.map(device => {
    const row = el('li', 'phone'), about = el('div', 'phone-about');
    const when = device.lastSeenAt && relativeTime(device.lastSeenAt);
    const seen = device.connected ? 'Connected now' : when ? `Last used ${/^(Just now|Yesterday)$/.test(when) ? when.toLowerCase() : when}` : 'Not used yet';
    about.append(el('strong', '', device.name), el('span', 'muted', `${seen} · Paired ${new Date(device.createdAt).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'})}`));
    const remove = el('button', 'quiet small remove-phone', 'Remove');
    remove.onclick = async () => {
      if (!confirm(`Remove "${device.name}"? It loses access to this Mac at once and needs a new pairing code to connect again.`)) return;
      remove.disabled = true;
      try { await api(`/devices/${encodeURIComponent(device.id)}/delete`, {}); } catch (error) { notice(error.message); remove.disabled = false; return; }
      loadPhones();
    };
    row.append(about, remove); return row;
  }));
}
