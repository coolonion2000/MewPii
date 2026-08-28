import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../api';
import { fetchModels, type ModelsResponse } from '../api';
import { t } from '../i18n';
import { restoreFailedImages, restoreFailedText } from '../state-utils';
import { IconPlus, IconArrowUp, IconStop, IconThink, IconChevronDown, IconX, IconWrench } from '../icons';

interface Props {
  conv: Conversation;
  draft?: string;
  onDraft?: (d: string | undefined) => void;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface PendingImage {
  data: string;
  mimeType: string;
  name: string;
}

export default function Composer({ conv, draft, onDraft }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [models, setModels] = useState<ModelsResponse | undefined>();
  const [menuOpen, setMenuOpen] = useState<'model' | 'thinking' | 'tools' | undefined>();
  const [queueMode, setQueueMode] = useState<'steer' | 'followUp'>('steer');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchModels().then(setModels).catch(() => undefined);
  }, []);

  // Live command discovery: built-ins, extension commands, prompts, and skills.
  const slashItems = (conv.snapshot?.slashCommands ?? []).map((command) => ({
    cmd: `/${command.name}`,
    desc: command.description ?? '',
  }));

  // external draft injection (e.g. editing a queued message)
  useEffect(() => {
    if (draft !== undefined) {
      setText(draft);
      onDraft?.(undefined);
      taRef.current?.focus();
      requestAnimationFrame(autoResize);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(undefined);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  const snap = conv.snapshot;
  const streaming = Boolean(snap?.isStreaming);
  const canSend = (text.trim().length > 0 || images.length > 0) && conv.connected;

  const autoResize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };

  const submit = async () => {
    const value = text.trim();
    if (!canSend) return;
    const imgs = images;
    setText('');
    setImages([]);
    requestAnimationFrame(autoResize);
    // optimistic render: show the message now, not after the server round-trip.
    // while streaming the message only enters the queue (steer/followUp) — the
    // queue strip shows it; a premature bubble would double-display it.
    // a leading "/cmd" is a pi slash command (compact, model, session, extension
    // commands) — route it to the command executor, not the LLM
    const slashMatch = value.match(/^\s*\/([^\s/]+)(\s+.*)?$/);
    if (slashMatch) {
      const optKey2 = streaming ? -1 : conv.addOptimistic(value, imgs.map(({ data, mimeType }) => ({ data, mimeType })));
      try {
        const res = await conv.send({ type: 'slash', raw: value });
        const output = (res as { output?: string } | undefined)?.output;
        if (output) conv.toast(output);
        else if (!conv.lastError) conv.toast(t('slashDone'));
        if (optKey2 >= 0) conv.removeOptimistic(optKey2);
      } catch (err) {
        if (optKey2 >= 0) conv.removeOptimistic(optKey2);
        conv.lastError = err instanceof Error ? err.message : String(err);
        setText((current) => restoreFailedText(current, value));
        setImages((current) => restoreFailedImages(current, imgs));
      }
      return;
    }
    const optKey = streaming ? -1 : conv.addOptimistic(value, imgs.map(({ data, mimeType }) => ({ data, mimeType })));
    try {
      await conv.send({
        type: 'prompt',
        message: value,
        images: imgs.length ? imgs.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
        streamingBehavior: streaming ? queueMode : undefined,
      });
    } catch (err) {
      if (optKey >= 0) conv.removeOptimistic(optKey);
      setText((current) => restoreFailedText(current, value));
      setImages((current) => restoreFailedImages(current, imgs));
      conv.lastError = err instanceof Error ? err.message : String(err);
    }
  };

  const addImages = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        setImages((prev) => [...prev, { data: base64, mimeType: file.type, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
  };

  // slash autocomplete: current word starts with '/'
  const slashQuery = (() => {
    if (text.includes(' ') && !text.startsWith('/')) return undefined;
    const m = text.match(/^\/([a-zA-Z0-9:_-]*)$/);
    return m ? m[1].toLowerCase() : undefined;
  })();
  const slashMatches = slashQuery !== undefined
    ? slashItems.filter((it) => it.cmd.slice(1).toLowerCase().startsWith(slashQuery)).slice(0, 8)
    : [];
  const [slashIndex, setSlashIndex] = useState(0);

  const currentModel = snap?.model;
  const currentModelInfo = models?.models.find(
    (m) => m.provider === currentModel?.provider && m.id === currentModel?.id,
  );
  const supportsImage = currentModelInfo?.input.includes('image') ?? true;
  const isReasoning = currentModelInfo?.reasoning ?? false;

  // derive tool mode from active tool names
  const activeTools = snap?.tools ?? [];
  const has = (n: string) => activeTools.includes(n);
  const toolMode: 'off' | 'read-only' | 'default' | 'full' | 'custom' =
    !has('read') && !has('bash') && !has('edit') && !has('write') ? 'off'
    : has('grep') || has('find') || has('ls') ? 'full'
    : has('bash') || has('edit') || has('write') ? 'default'
    : 'read-only';
  const configuredModels = models?.models.filter((m) => m.hasAuth) ?? [];

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="image-strip">
          {images.map((img, i) => (
            <div key={i} className="image-thumb">
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} />
              <button
                className="image-remove"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <IconX size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div className="slash-menu">
          {slashMatches.map((it, i) => (
            <button
              key={it.cmd}
              className={`menu-item ${i === slashIndex ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setText(it.cmd + ' ');
                setSlashIndex(0);
                taRef.current?.focus();
              }}
            >
              <span className="mono">{it.cmd}</span>
              <span className="dim">{it.desc.slice(0, 40)}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        placeholder={streaming ? t('steerPlaceholder') : t('sendPlaceholder')}
        onChange={(e) => {
          setText(e.target.value);
          autoResize();
        }}
        onKeyDown={(e) => {
          if (slashMatches.length > 0 && !e.nativeEvent.isComposing) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSlashIndex((i) => (i + 1) % slashMatches.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
              return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              e.preventDefault();
              setText(slashMatches[Math.min(slashIndex, slashMatches.length - 1)].cmd + ' ');
              setSlashIndex(0);
              requestAnimationFrame(autoResize);
              return;
            }
            if (e.key === 'Escape') {
              setText(text + ' ');
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        onPaste={(e) => {
          const files = e.clipboardData?.files;
          if (files && files.length > 0) {
            e.preventDefault();
            addImages(files);
          }
        }}
      />

      {/* bottom bar: + attach | queue mode … model chip · thinking · spinner · send circle */}
      <div className="composer-bar">
        {supportsImage && (
          <>
            <button className="round-btn" title={t('attachImage')} onClick={() => imgInputRef.current?.click()}>
<IconPlus size={16} />
            </button>
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                addImages(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}

        {streaming && (
          <div className="queue-mode">
            <button
              className={`qm-btn ${queueMode === 'steer' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setQueueMode('steer');
              }}
            >
              {t('sendSteer')}
            </button>
            <button
              className={`qm-btn ${queueMode === 'followUp' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setQueueMode('followUp');
              }}
            >
              {t('sendFollowUp')}
            </button>
          </div>
        )}

        <span style={{ flex: 1 }} />

        {/* model + thinking combined chip, pi-web style */}
        <div className="menu-anchor">
          <button
            className="model-chip"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(menuOpen === 'model' ? undefined : 'model');
            }}
          >
            <span className="model-chip-name">{currentModel ? currentModel.name : t('selectModel')}</span>
            {currentModel && isReasoning && (
              <span className="model-chip-qualifier">{snap?.thinkingLevel ?? 'off'}</span>
            )}
<IconChevronDown size={12} />
          </button>
          {menuOpen === 'model' && (
            <div className="menu combined-menu menu-right" onClick={(e) => e.stopPropagation()}>
              <div className="menu-section">
                <div className="menu-section-label">{t('selectModel')}</div>
                {(() => {
                  // group by provider: provider name as section label, rows without provider suffix
                  const groups: { provider: string; items: typeof configuredModels }[] = [];
                  for (const m of configuredModels) {
                    const g = groups.find((x) => x.provider === m.provider);
                    if (g) g.items.push(m);
                    else groups.push({ provider: m.provider, items: [m] });
                  }
                  return groups.map((g) => (
                    <div key={g.provider}>
                      <div className="menu-group-label">{g.provider}</div>
                      {g.items.map((m) => (
                        <button
                          key={`${m.provider}/${m.id}`}
                          className={`menu-item ${currentModel?.provider === m.provider && currentModel.id === m.id ? 'active' : ''}`}
                          onClick={() => {
                            // keep open: user usually picks the level right after
                            conv.applyOptimisticModel(m.provider, m.id, m.name);
                            void conv.send({ type: 'setModel', provider: m.provider, modelId: m.id }).catch(() => undefined);
                          }}
                        >
                          <span>{m.name}</span>
                        </button>
                      ))}
                    </div>
                  ));
                })()}
                {configuredModels.length === 0 && (
                  <div style={{ padding: 10, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('noConfiguredModels')}</div>
                )}
              </div>
              {isReasoning && (
                <div className="menu-section">
                  <div className="menu-section-label">{t('thinkingLevel')}</div>
                  {(() => {
                    const avail = snap?.availableThinkingLevels;
                    const levels = avail && avail.length > 0
                      ? ['off', ...avail.filter((l) => l !== 'off')]
                      : THINKING_LEVELS;
                    return levels.map((level) => (
                      <button
                        key={level}
                        className={`menu-item ${snap?.thinkingLevel === level ? 'active' : ''}`}
                        onClick={() => {
                          setMenuOpen(undefined);
                          conv.applyOptimisticThinking(level);
                          void conv.send({ type: 'setThinkingLevel', level }).catch(() => undefined);
                        }}
                      >
                        {level}
                      </button>
                    ));
                  })()}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="menu-anchor">
          <button
            className="model-chip"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(menuOpen === 'tools' ? undefined : 'tools');
            }}
          >
            <IconWrench size={13} />
            <span className="model-chip-qualifier">{toolMode}</span>
            <IconChevronDown size={11} />
          </button>
          {menuOpen === 'tools' && (
            <div className="menu menu-right" onClick={(e) => e.stopPropagation()}>
              {(
                [
                  ['off', t('toolModeOff'), t('toolModeOffDesc')],
                  ['read-only', t('toolModeReadOnly'), t('toolModeReadOnlyDesc')],
                  ['default', t('toolModeDefault'), t('toolModeDefaultDesc')],
                  ['full', t('toolModeFull'), t('toolModeFullDesc')],
                ] as const
              ).map(([mode, label, desc]) => (
                <button
                  key={mode}
                  className={`menu-item ${toolMode === mode ? 'active' : ''}`}
                  onClick={() => {
                    setMenuOpen(undefined);
                    void conv.send({ type: 'setToolMode', mode }).catch(() => undefined);
                  }}
                >
                  <span>{label}</span>
                  <span className="dim">{desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {streaming && <ContextRing conv={conv} />}

        {streaming ? (
          <button
            className="send-circle stop send-sm"
            title={t('abort')}
            onClick={() => void conv.send({ type: 'abort' }).catch(() => undefined)}
          >
            <IconStop size={16} />
          </button>
        ) : (
          <button className="send-circle send-sm" title={t('send')} disabled={!canSend} onClick={() => void submit()}>
<IconArrowUp size={17} />
          </button>
        )}
      </div>
    </div>
  );
}


/** Small ring showing current context usage while streaming. */
function ContextRing({ conv }: { conv: Conversation }) {
  const pct = conv.snapshot?.stats?.contextPercent ?? null;
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const R = 8;
  const C = 2 * Math.PI * R;
  const color = p >= 90 ? 'var(--dsw-alias-state-error-primary)' : p >= 70 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-business-primary)';
  return (
    <span className="context-ring" title={`${t('context')} ${Math.round(p)}%`}>
      <svg width="18" height="18" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={R} fill="none" stroke="var(--dsw-alias-border-l2)" strokeWidth="2.5" />
        {pct != null && (
          <circle
            cx="10" cy="10" r={R} fill="none" stroke={color} strokeWidth="2.5"
            strokeDasharray={`${(C * p) / 100} ${C}`}
            strokeLinecap="round" transform="rotate(-90 10 10)"
          />
        )}
      </svg>
      {pct == null && <span className="context-ring-spin" />}
    </span>
  );
}
