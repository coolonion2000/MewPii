import { useEffect, useReducer, useRef, useState } from 'react';
import type { Conversation } from '../api';
import { fetchModels, type ModelsResponse } from '../api';
import { t } from '../i18n';
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

  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!conv.snapshot?.isStreaming) return;
    const timer = setInterval(force, 1000);
    return () => clearInterval(timer);
  }, [conv.snapshot?.isStreaming]);

  // slash commands (skills + prompt templates) for autocomplete
  const [slashItems, setSlashItems] = useState<{ cmd: string; desc: string }[]>([]);
  useEffect(() => {
    const cwd = conv.snapshot?.cwd ?? conv.cwd;
    fetch(`/api/resources?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { skills?: { name: string; description?: string }[]; prompts?: { name: string; description?: string }[] }) => {
        const items: { cmd: string; desc: string }[] = [];
        for (const sk of d.skills ?? []) items.push({ cmd: `/skill:${sk.name}`, desc: sk.description ?? '' });
        for (const p of d.prompts ?? []) items.push({ cmd: `/${p.name}`, desc: p.description ?? '' });
        setSlashItems(items);
      })
      .catch(() => undefined);
  }, [conv.snapshot?.cwd, conv.cwd]);

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
    try {
      await conv.send({
        type: 'prompt',
        message: value,
        images: imgs.length ? imgs.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
        streamingBehavior: streaming ? queueMode : undefined,
      });
    } catch (err) {
      setText(value);
      setImages(imgs);
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

        {/* live stream counter: ↓tokens · t/s (pi-web style) */}
        {streaming && (() => {
          const run = conv.runStats;
          const estTokens = Math.round(run.outputChars / 3.5);
          const genSec = Math.max(0.5, (Date.now() - (run.firstDeltaAt ?? Date.now())) / 1000);
          const tps = estTokens > 0 ? (estTokens / genSec).toFixed(1) : '…';
          return (
            <span className="live-counter" title={t('liveCounter')}>
              ↓{estTokens > 0 ? estTokens : ''}
              <span className="live-tps">{tps} t/s</span>
            </span>
          );
        })()}

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
            <div className="menu" onClick={(e) => e.stopPropagation()}>
              {configuredModels.map((m) => (
                <button
                  key={`${m.provider}/${m.id}`}
                  className={`menu-item ${currentModel?.provider === m.provider && currentModel.id === m.id ? 'active' : ''}`}
                  onClick={() => {
                    setMenuOpen(undefined);
                    void conv.send({ type: 'setModel', provider: m.provider, modelId: m.id }).catch(() => undefined);
                  }}
                >
                  <span>{m.name}</span>
                  <span className="dim">{m.provider}</span>
                </button>
              ))}
              {configuredModels.length === 0 && (
                <div style={{ padding: 10, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('noConfiguredModels')}</div>
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
            <div className="menu" onClick={(e) => e.stopPropagation()}>
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

        {isReasoning && (
          <div className="menu-anchor">
            <button
              className="model-chip"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(menuOpen === 'thinking' ? undefined : 'thinking');
              }}
            >
<IconThink size={14} />
              <span className="model-chip-qualifier">{snap?.thinkingLevel ?? 'off'}</span>
<IconChevronDown size={11} />
            </button>
            {menuOpen === 'thinking' && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                {THINKING_LEVELS.map((level) => (
                  <button
                    key={level}
                    className={`menu-item ${snap?.thinkingLevel === level ? 'active' : ''}`}
                    onClick={() => {
                      setMenuOpen(undefined);
                      void conv.send({ type: 'setThinkingLevel', level }).catch(() => undefined);
                    }}
                  >
                    {level}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {streaming && <span className="composer-spinner" />}

        {streaming ? (
          <button
            className="send-circle stop"
            title={t('abort')}
            onClick={() => void conv.send({ type: 'abort' }).catch(() => undefined)}
          >
            <IconStop size={13} />
          </button>
        ) : (
          <button className="send-circle" title={t('send')} disabled={!canSend} onClick={() => void submit()}>
<IconArrowUp size={17} />
          </button>
        )}
      </div>
    </div>
  );
}
