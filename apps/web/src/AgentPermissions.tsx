import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';

type Text = { en: string; ja: string };
type Permission = { id: string; group: 'read' | 'write'; route: string; label: Text; detail: Text };
type Owner = { enabled: string[]; agents: { agentId: string; disabled: string[] }[] };

// Call Matsuri's agent API; its error message is shown as is.
// Matsuri のエージェント API を呼び出す。エラー文はそのまま表示する。
async function call<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { 'Owner-Session': token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  // With the agent API off, the server answers with the page or an error page instead of JSON.
  // エージェント API が停止中は、サーバーが JSON ではなくページやエラーページを返す。
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(i18n.t('agentApiMissing'));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
}

// A button that opens Matsuri's permission list; a signed-in owner switches each permission for all their agents, and can narrow one agent.
// Matsuri の権限一覧を開くボタン。サインインした所有者は全エージェント分の各権限を切り替え、個別のエージェントを絞り込める。
export default function AgentPermissions({ address }: { address: string | null }) {
  const { t, i18n } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState<Owner | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lang = i18n.language === 'ja' ? 'ja' : 'en';

  // A sign-in belongs to one wallet; switching accounts signs out.
  // サインインは1つのウォレットに紐づくため、アカウントを切り替えるとサインアウトする。
  useEffect(() => {
    setToken('');
    setOwner(null);
  }, [address]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    dialog.current?.showModal();
    if (!permissions.length) run(async () => setPermissions(await call<Permission[]>('/permissions')));
  };

  // Proves wallet ownership with a message signature: no transaction, no gas.
  // メッセージ署名でウォレット所有を証明する（トランザクション・ガス不要）。
  const signIn = () =>
    run(async () => {
      if (!address || !window.ethereum) return;
      const challenge = await call<{ nonce: string; message: string }>('/owner/challenge', undefined, { wallet: address });
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [challenge.message, address] });
      const session = await call<{ token: string }>('/owner/session', undefined, { nonce: challenge.nonce, signature });
      setToken(session.token);
      setOwner(await call<Owner>('/owner/permissions', session.token));
    });

  // The switch shows the server's saved state, so it only moves once the change has persisted.
  // スイッチはサーバーに保存された状態を表示するため、変更が保存されてから切り替わる。
  const toggle = (permission: string, enabled: boolean, agentId?: string) =>
    run(async () => setOwner(await call<Owner>('/owner/permission', token, { permission, enabled, agentId })));

  const switchFor = (permission: Permission, agentId?: string) => {
    if (!owner) return null;
    const allowed = owner.enabled.includes(permission.id);
    const narrowed = owner.agents.find((agent) => agent.agentId === agentId)?.disabled.includes(permission.id);
    return (
      <input
        type="checkbox"
        disabled={busy || (agentId !== undefined && !allowed)}
        checked={allowed && !narrowed}
        onChange={(e) => toggle(permission.id, e.target.checked, agentId)}
      />
    );
  };

  const groups = (agentId?: string) =>
    (['read', 'write'] as const).map((group) => (
      <div key={group} className="permission-group">
        <h4>{t(group === 'read' ? 'permRead' : 'permWrite')}</h4>
        {permissions
          .filter((permission) => permission.group === group)
          .map((permission) => (
            <label key={permission.id} className="permission">
              {switchFor(permission, agentId)}
              <span>
                <strong>{permission.label[lang]}</strong>
                {agentId === undefined && (
                  <>
                    {' '}
                    {permission.detail[lang]} <code>{permission.route}</code>
                  </>
                )}
              </span>
            </label>
          ))}
      </div>
    ));

  return (
    <>
      <button onClick={open}>{t('agentPermissions')}</button>
      <dialog ref={dialog} className="agent-dialog">
        <div className="panel-header">
          <h2>{t('agentPermissions')}</h2>
          <p>{t('agentPermissionsNote')}</p>
        </div>
        {groups()}
        {!owner &&
          (address ? (
            <button onClick={signIn} disabled={busy}>
              {t('agentSignIn')}
            </button>
          ) : (
            <p>{t('agentConnectFirst')}</p>
          ))}
        {owner && (
          <div className="panel-header">
            <h3>{t('agentYourAgents')}</h3>
            <p>{owner.agents.length ? t('agentNarrowNote') : t('agentNone')}</p>
          </div>
        )}
        {owner?.agents.map((agent) => (
          <article key={agent.agentId} className="card">
            <h3 className="mono agent-id">{agent.agentId}</h3>
            {groups(agent.agentId)}
          </article>
        ))}
        {error && <p className="agent-error">{error}</p>}
        <form method="dialog">
          <button>{t('close')}</button>
        </form>
      </dialog>
    </>
  );
}
