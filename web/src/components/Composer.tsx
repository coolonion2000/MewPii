import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Conversation } from '../api';
import { DeliveryNotSentError, DeliveryUnknownError, fetchModels, getCachedModels, type ModelsResponse } from '../api';
import { t } from '../i18n';
import { conversationPhase, phaseTranslationKey } from '../conversation-phase';
import ImagePreview from './ImagePreview';
import { imageDataUrl } from '../image-preview-utils';
import { mentionQuery, mentionMessage, parseMentionMessage, mergeMentions, type FileMention } from '../file-mentions';
import { useFileMentionSearch, type MentionCandidate } from '../use-file-mention-search';
import FileMentionChips from './FileMentionChips';
import { commandNoticeFallback, restoreFailedImages, restoreFailedText } from '../state-utils';
import { searchSlashCommands } from '../slash-search';
import { IconPlus, IconArrowUp, IconStop, IconChevronDown, IconX, IconWrench, IconCheck } from '../icons';
import {
  clearComposerDraft,
  conversationDraftKey,
  getComposerDraft,
  restoreFailedComposerDraft,
  setComposerDraft,
  type ComposerDraftImage,
} from '../draft-store';
import {
  MODEL_CATALOG_CHANGED_EVENT,
} from '../ui-reliability';

interface Props {
  conv: Conversation;
  draft?: string;
  onDraft?: (d: string | undefined) => void;
  onOpenFile?: (path: string) => void;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

type PendingImage = ComposerDraftImage;

export default function Composer({ conv, draft, onDraft, onOpenFile }: Props) {
  const initialDraftKey = conversationDraftKey(
    conv.agent,
    conv.snapshot?.cwd ?? conv.cwd,
    conv.snapshot?.sessionFile ?? conv.sessionPath,
  );
  const [initialDraft] = useState(() => getComposerDraft(initialDraftKey));
  const [text, setText] = useState(initialDraft?.text ?? '');
  const [images, setImages] = useState<PendingImage[]>(initialDraft?.images ?? []);
  const [mentions, setMentions] = useState<FileMention[]>(initialDraft?.mentions ?? []);
  const [cursor, setCursor] = useState(initialDraft?.text.length ?? 0);
  const [inputFocused, setInputFocused] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  const mention = inputFocused && !mentionDismissed && !composing && mentions.length < 24 ? mentionQuery(text, cursor) : undefined;
  const mentionSearch = useFileMentionSearch(mention?.query, conv.snapshot?.cwd ?? conv.cwd, conv.agent);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setMentionIndex(0), [mention?.query]);
  useEffect(() => { mentionMenuRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); }, [mentionIndex]);
  const [models, setModels] = useState<ModelsResponse | undefined>(getCachedModels);
  const [modelsLoading, setModelsLoading] = useState(() => !getCachedModels());
  const [modelsError, setModelsError] = useState<string>();
  const [selectingModel, setSelectingModel] = useState(false);
  const [menuOpen, setMenuOpen] = useState<'model' | 'thinking' | 'tools' | undefined>();
  const [queueMode, setQueueMode] = useState<'steer' | 'followUp'>('steer');
  const [submitPending, setSubmitPending] = useState(false);
  const [pendingSlash, setPendingSlash] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();
  const [checkingDelivery, setCheckingDelivery] = useState<string>();
  const unconfirmedDrafts = useRef(new Map<string, {
    text: string; images: PendingImage[]; mentions: FileMention[]; optimisticKey: number;
    draftKey: string; sessionId?: string; recoveryNeeded?: boolean;
  }>());
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const editorHasDraft = useRef(false);
  editorHasDraft.current = Boolean(text.trim() || images.length || mentions.length);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [imagePreview, setImagePreview] = useState<string>();
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mobileExpanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (imagePreview) return;
      if (!composerRef.current?.contains(event.target as Node)) {
        setMobileExpanded(false);
        setMenuOpen(undefined);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [mobileExpanded, imagePreview]);
  const submitPendingRef = useRef(false);
  const stoppingRef = useRef(false);
  const stopGeneration = useRef(0);
  const modelsGeneration = useRef(0);
  const modelsFocusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const draftKey = conversationDraftKey(
    conv.agent,
    conv.snapshot?.cwd ?? conv.cwd,
    conv.snapshot?.sessionFile ?? conv.sessionPath,
  );
  const previousDraftKey = useRef(draftKey);
  useEffect(() => {
    const timer = setTimeout(() => conv.syncEditorText(mentionMessage(text, mentions)), 150);
    return () => clearTimeout(timer);
  }, [conv, conv.connected, text, mentions]);
  const appliedEditorRevision = useRef(0);
  useEffect(() => {
    const update = conv.editorUpdate;
    if (!update || update.revision <= appliedEditorRevision.current) return;
    appliedEditorRevision.current = update.revision;
    const parsed = parseMentionMessage(update.text);
    setText(current => update.mode === 'append' ? current + parsed.text : parsed.text);
    setMentions(current => update.mode === 'append' ? mergeMentions(current, parsed.mentions) : parsed.mentions);
  }, [conv, conv.editorUpdate?.revision]);

  useEffect(() => {
    if (previousDraftKey.current !== draftKey)
      clearComposerDraft(previousDraftKey.current);
    setComposerDraft(draftKey, { text, images, mentions });
    previousDraftKey.current = draftKey;
  }, [draftKey, text, images, mentions]);

  const loadModels = useCallback(async (force = false) => {
    const generation = ++modelsGeneration.current;
    setModelsLoading(!getCachedModels());
    setModelsError(undefined);
    try {
      const next = await fetchModels(force);
      if (generation !== modelsGeneration.current) return;
      setModels(next);
    } catch (cause) {
      if (generation !== modelsGeneration.current) return;
      setModelsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === modelsGeneration.current) setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels();
    const refresh = () => {
      clearTimeout(modelsFocusTimer.current);
      modelsFocusTimer.current = setTimeout(() => void loadModels(true), 80);
    };
    const refreshFromCatalog = () => void loadModels();
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, refreshFromCatalog);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      modelsGeneration.current += 1;
      clearTimeout(modelsFocusTimer.current);
      window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, refreshFromCatalog);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadModels]);

  // Live command discovery: built-ins, extension commands, prompts, and skills.
  const slashItems = (conv.snapshot?.slashCommands ?? []).map((command) => ({
    cmd: `/${command.name}`,
    desc: command.description ?? '',
  }));

  // external draft injection (e.g. editing a queued message)
  useEffect(() => {
    if (draft !== undefined) {
      const parsed = parseMentionMessage(draft);
      setText(parsed.text);
      setMentions(parsed.mentions);
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
  const phase = conversationPhase(conv, stopping);
  const restoreUnconfirmedDraft = (id: string, append = false) => {
    const saved = unconfirmedDrafts.current.get(id);
    if (!saved) return;
    if (saved.optimisticKey >= 0) {
      conv.removeOptimistic(saved.optimisticKey);
      saved.optimisticKey = -1;
    }
    if (saved.sessionId !== conv.snapshot?.sessionId) {
      const prior = getComposerDraft(saved.draftKey);
      setComposerDraft(saved.draftKey, {
        text: [prior?.text, saved.text].filter(Boolean).join('\n\n'),
        images: restoreFailedImages(prior?.images ?? [], saved.images),
        mentions: mergeMentions(prior?.mentions ?? [], saved.mentions),
      });
      unconfirmedDrafts.current.delete(id);
      return;
    }
    if (editorHasDraft.current && !append) {
      if (!saved.recoveryNeeded) {
        saved.recoveryNeeded = true;
        setRecoveryRevision(value => value + 1);
      }
      return;
    }
    // Reserve the editor synchronously when several failures settle together.
    editorHasDraft.current = true;
    setText(current => append ? [current, saved.text].filter(Boolean).join('\n\n') : restoreFailedText(current, saved.text));
    setImages(current => restoreFailedImages(current, saved.images));
    setMentions(current => mergeMentions(saved.mentions, current));
    unconfirmedDrafts.current.delete(id);
    setRecoveryRevision(value => value + 1);
  };
  const deliveryRevision = conv.getRevision();
  useEffect(() => {
    for (const id of unconfirmedDrafts.current.keys()) {
      const delivery = conv.getDelivery(id);
      if (delivery?.state === 'failed') restoreUnconfirmedDraft(id);
      else if (delivery?.state === 'accepted') unconfirmedDrafts.current.delete(id);
    }
  }, [conv, deliveryRevision]);
  const checkDelivery = async (id: string) => {
    if (checkingDelivery) return;
    setCheckingDelivery(id);
    try {
      const result = await conv.checkDelivery(id);
      if (typeof result?.editorText === 'string') setText(result.editorText);
    } catch (error) {
      if (!(error instanceof DeliveryUnknownError)) restoreUnconfirmedDraft(id);
    } finally { setCheckingDelivery(undefined); }
  };
  const unsettledDeliveries = conv.unsettledDeliveries;
  const deliveries = [...unsettledDeliveries,
    ...(conv.delivery && !unsettledDeliveries.some(item => item.id === conv.delivery?.id) ? [conv.delivery] : [])];
  for (const [id, saved] of unconfirmedDrafts.current) {
    if (saved.recoveryNeeded && !deliveries.some(item => item.id === id)) {
      deliveries.push(conv.getDelivery(id) ?? {id, type: 'prompt', state: 'failed', updatedAt: 0});
    }
  }
  const attentionDeliveries = deliveries.filter(delivery => delivery.state !== 'accepted');
  // A quiet acknowledgement must never obscure another message still needing attention.
  const acceptedDelivery = attentionDeliveries.length === 0 && conv.delivery?.state === 'accepted'
    ? conv.delivery : undefined;
  const streaming = Boolean(snap?.isStreaming);
  const activeOperation = streaming || Boolean(conv.compaction);
  const hasPayload = text.trim().length > 0 || images.length > 0 || mentions.length > 0;
  const connectionKnownFailed = conv.serviceUnresponsive || (!conv.connected && Boolean(conv.error));
  const canSend = hasPayload && !submitPending && !selectingModel && !connectionKnownFailed && unconfirmedDrafts.current.size < 64;

  useEffect(() => {
    if (!activeOperation) {
      stopGeneration.current += 1;
      stoppingRef.current = false;
      setStopping(false);
      setStopError(undefined);
    }
  }, [activeOperation]);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    const generation = ++stopGeneration.current;
    stoppingRef.current = true;
    setStopping(true);
    setStopError(undefined);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('timeout')),
          15_000,
        );
      });
      await Promise.race([conv.stop(), timeout]);
    } catch (cause) {
      const message = cause instanceof Error && !['TimeoutError', 'AbortError', 'TypeError'].includes(cause.name) && cause.message !== 'timeout'
        ? cause.message : t('stopUnavailable');
      if (generation === stopGeneration.current) {
        setStopError(message);
      }
    } finally {
      clearTimeout(timeoutId);
      if (generation === stopGeneration.current) {
        stoppingRef.current = false;
        setStopping(false);
      }
    }
  }, [conv]);

  const autoResize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };

  const submit = async () => {
    const rawText = text.trim();
    const refs = mentions;
    const value = mentionMessage(rawText, refs);
    if (!canSend || submitPendingRef.current) return;
    const imgs = images;
    submitPendingRef.current = true;
    setSubmitPending(true);
    let cleared = false;
    let optimisticKey = -1;
    let dispatched = false;
    const slashMatch = refs.length ? null : value.match(/^\s*\/([^\s/]+)(\s+.*)?$/);
    setPendingSlash(Boolean(slashMatch));
    try {
      clearComposerDraft(draftKey);
      setText('');
      setImages([]);
      setMentions([]);
      setMentionDismissed(true);
      cleared = true;
      requestAnimationFrame(autoResize);

      // Show a cold-session prompt immediately while the server finishes
      // extension/resource initialization. Commands and queued steering stay
      // non-optimistic because they are not durable chat bubbles.
      if (!slashMatch && !conv.snapshot?.isStreaming) {
        optimisticKey = conv.addOptimistic(
          value,
          imgs.map(({ data, mimeType }) => ({ data, mimeType })),
        );
      }
      // A new host may need several seconds to load extensions and emit its
      // first snapshot. Accept the click now and deliver once it is ready.
      await conv.waitUntilReady();

      const activeStreaming = Boolean(conv.snapshot?.isStreaming);
      // optimistic render: show the message now, not after the server round-trip.
      // while streaming the message only enters the queue (steer/followUp) — the
      // queue strip shows it; a premature bubble would double-display it.
      // Pi executes slash commands outside persisted chat messages. Their
      // non-persisted output is inserted separately into the transcript.
      if (activeStreaming && optimisticKey >= 0) {
        conv.removeOptimistic(optimisticKey);
        optimisticKey = -1;
      } else if (!activeStreaming && !slashMatch && optimisticKey < 0) {
        optimisticKey = conv.addOptimistic(
            value,
            imgs.map(({ data, mimeType }) => ({ data, mimeType })),
          );
      }
      if (slashMatch) {
        const noticeRevision = conv.transcriptNoticeRevision;
        dispatched = true;
        const res = await conv.send({ type: 'slash', raw: value });
        if (typeof res?.editorText === 'string') setText(res.editorText);
        if (res?.action === 'quit') conv.requestQuit();
        const output = (res as { output?: string } | undefined)?.output;
        const notice = commandNoticeFallback(
          noticeRevision,
          conv.transcriptNoticeRevision,
          output,
          t('slashDone'),
        );
        if (notice) conv.showTranscriptNotice(notice);
        if (optimisticKey >= 0) conv.removeOptimistic(optimisticKey);
        return;
      }
      dispatched = true;
      const result = await conv.send({
        type: 'prompt',
        message: value,
        images: imgs.length
          ? imgs.map(({ data, mimeType }) => ({ data, mimeType }))
          : undefined,
        streamingBehavior: activeStreaming ? queueMode : undefined,
      });
      if (result?.deliveryAlreadySubmitted && optimisticKey >= 0) conv.removeOptimistic(optimisticKey);
    } catch (err) {
      if (err instanceof DeliveryNotSentError) {
        if (optimisticKey >= 0) conv.removeOptimistic(optimisticKey);
        // The editor may already belong to a different session. Restore only
        // the captured source draft, never insert it into the new conversation.
        restoreFailedComposerDraft(draftKey, {text: rawText, images: imgs, mentions: refs});
        conv.reportError(t('sendPreparationInterrupted'));
        return;
      }
      if (err instanceof DeliveryUnknownError) {
        // A missing receipt is not a failed send: keep the bubble and do not
        // restore a resendable draft until the server explicitly rejects it.
        if (err.alreadySubmitted && optimisticKey >= 0) {
          conv.removeOptimistic(optimisticKey);
          optimisticKey = -1;
        }
        if (!unconfirmedDrafts.current.has(err.deliveryId))
          unconfirmedDrafts.current.set(err.deliveryId, {text: rawText, images: imgs, mentions: refs, optimisticKey, draftKey, sessionId: snap?.sessionId});
        return;
      }
      // After dispatch, session navigation may only have disposed this browser
      // connection; keep the pending bubble until the server echo reconciles it.
      const disposed =
        err instanceof Error && err.message === 'conversation disposed';
      if (dispatched && disposed) return;
      if (optimisticKey >= 0) conv.removeOptimistic(optimisticKey);
      if (cleared) {
        if (!dispatched && disposed) {
          restoreFailedComposerDraft(draftKey, { text: rawText, images: imgs, mentions: refs });
        }
        setText((current) => restoreFailedText(current, rawText));
        setImages((current) => restoreFailedImages(current, imgs));
        setMentions(current => mergeMentions(refs, current));
      }
      conv.reportError(err instanceof Error ? err.message : String(err));
    } finally {
      submitPendingRef.current = false;
      setSubmitPending(false);
      setPendingSlash(false);
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
    ? searchSlashCommands(slashItems, slashQuery)
    : [];
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setSlashIndex(0), [slashQuery]);
  useEffect(() => {
    slashMenuRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashQuery]);

  const currentModel = snap?.model;
  const currentModelInfo = models?.models.find(
    (m) => m.provider === currentModel?.provider && m.id === currentModel?.id,
  );
  const supportsImage = currentModelInfo?.input.includes('image') ?? true;
  const selectMention = (item: MentionCandidate) => {
    if (!mention || mentions.length >= 24) return;
    const path = `${mentionSearch.cwd.replace(/\/$/, '')}/${item.path}`;
    setMentions(current => mergeMentions(current, [{ path, isDir: item.isDir }]));
    const next = text.slice(0, mention.start) + text.slice(mention.end);
    setText(next); setCursor(mention.start); setMentionDismissed(true);
    requestAnimationFrame(() => { taRef.current?.focus(); taRef.current?.setSelectionRange(mention.start, mention.start); autoResize(); });
  };
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
    <div ref={composerRef} className={`composer ${mobileExpanded || images.length > 0 || mentions.length > 0 ? 'mobile-expanded' : 'mobile-compact'} ${hasPayload || activeOperation || submitPending ? 'mobile-has-action' : ''}`}>
      <FileMentionChips items={mentions} onRemove={path => setMentions(items => items.filter(item => item.path !== path))} disabled={submitPending} onOpenFile={onOpenFile} />
      {mention && <div className="mention-menu" ref={mentionMenuRef} id="file-mention-list" role="listbox" aria-label={t('referenceFiles')}>
        <div className="mention-menu-heading">{t('referenceFiles')}</div>
        {mentionSearch.loading ? <div role="status">{t('mentionSearching')}</div> : mentionSearch.error ? <div role="alert">{mentionSearch.error}</div> : mentionSearch.items.length === 0 ? <div>{t('mentionEmpty')}</div> : mentionSearch.items.map((item, i) => <button
          key={item.path} id={`file-mention-${i}`} role="option" aria-selected={i === mentionIndex} type="button" className={`mention-option ${i === mentionIndex ? 'active' : ''}`}
          onMouseDown={e => e.preventDefault()} onClick={() => selectMention(item)}>
          <span>{item.isDir ? '📁' : '📄'} {item.name}</span><small>{item.path}</small>
        </button>)}
        <div className="mention-menu-hint">{mentionSearch.truncated ? t('mentionTruncated') : t('mentionHint')}</div>
      </div>}
      <button type="button" className="mobile-composer-expand round-btn" aria-label={t('expandComposer')} aria-expanded={mobileExpanded}
        onClick={() => { setMobileExpanded(true); taRef.current?.focus(); }}><IconPlus size={19} /></button>
      {images.length > 0 && (
        <div className="image-strip">
          {images.map((img, i) => (
            <div key={i} className="image-thumb">
              <button type="button" className="image-preview-trigger" aria-label={`${t('imagePreview')}: ${img.name}`} onClick={() => setImagePreview(imageDataUrl(img.data, img.mimeType))}>
                <img src={imageDataUrl(img.data, img.mimeType)} alt={img.name} />
              </button>
              <button
                type="button"
                aria-label={t('removeImage')}
                className="image-remove"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <IconX size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {imagePreview && <ImagePreview src={imagePreview} onClose={() => setImagePreview(undefined)} />}
      {!mention && slashMatches.length > 0 && (
        <div className="slash-menu" ref={slashMenuRef}>
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
        onFocus={() => { setMobileExpanded(true); setInputFocused(true); }}
        onBlur={(event) => { if (!event.relatedTarget || !mentionMenuRef.current?.contains(event.relatedTarget as Node)) setInputFocused(false); }}
        onSelect={event => setCursor(event.currentTarget.selectionStart)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={event => { setComposing(false); setCursor(event.currentTarget.selectionStart); }}
        aria-autocomplete="list"
        aria-controls={mention ? 'file-mention-list' : undefined}
        aria-activedescendant={mention && mentionSearch.items.length ? `file-mention-${mentionIndex}` : undefined}
        value={text}
        readOnly={submitPending}
        placeholder={
          connectionKnownFailed
            ? t('disconnected')
            : submitPending
              ? t(pendingSlash && conv.connected ? 'commandPending' : 'connectingSession')
              : streaming
                ? t('steerPlaceholder')
                : t('sendPlaceholder')
        }
        onChange={(e) => {
          setText(e.target.value);
          setCursor(e.target.selectionStart);
          setMentionDismissed(false);
          autoResize();
        }}
        onKeyDown={(e) => {
          if (composing || e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (mention && !e.nativeEvent.isComposing) {
            if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return; }
            const count = mentionSearch.items.length;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (count) setMentionIndex(i => (i + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
              return;
            }
            if (count && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault(); selectMention(mentionSearch.items[Math.min(mentionIndex, count - 1)]); return;
            }
            // Do not submit while the user is waiting for the lookup to resolve.
            if (mentionSearch.loading && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return; }
          }
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
          // On phone keyboards Enter is the newline key; the send button is
          // the explicit submit action. Desktop keeps Enter-to-send.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(max-width: 700px)').matches) {
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

        <span className="composer-spacer" style={{ flex: 1 }} />

        {/* model + thinking combined chip, pi-web style */}
        <div className="menu-anchor composer-model">
          <button
            className="model-chip"
            onClick={(e) => {
              e.stopPropagation();
              const opening = menuOpen !== 'model';
              setMenuOpen(opening ? 'model' : undefined);
              if (opening && (modelsError || !models)) void loadModels(true);
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
                {modelsLoading && (
                  <div className="model-load-state" role="status">
                    <span className="working-dot" aria-hidden="true" />
                    {t('loadingModels')}
                  </div>
                )}
                {modelsError && (
                  <div className="model-load-error" role="alert">
                    <span>{t('modelLoadFailed')}: {modelsError}</span>
                    <button className="btn btn-sm" onClick={() => void loadModels(true)}>{t('retry')}</button>
                  </div>
                )}
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
                          disabled={selectingModel}
                          className={`menu-item ${currentModel?.provider === m.provider && currentModel.id === m.id ? 'active' : ''}`}
                          onClick={() => {
                            // keep open: user usually picks the level right after
                            setSelectingModel(true);
                            void conv
                              .selectModel(m.provider, m.id)
                              .catch((err) => conv.reportError(err instanceof Error ? err.message : String(err)))
                              .finally(() => setSelectingModel(false));
                          }}
                        >
                          <span>{m.name}{selectingModel ? ' …' : ''}</span>
                        </button>
                      ))}
                    </div>
                  ));
                })()}
                {!modelsLoading && !modelsError && configuredModels.length === 0 && (
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
                          void conv
                            .send({ type: 'setThinkingLevel', level })
                            .catch((err) => conv.reportError(err instanceof Error ? err.message : String(err)));
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
                    void conv
                      .send({ type: 'setToolMode', mode })
                      .catch((err) => conv.reportError(err instanceof Error ? err.message : String(err)));
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
        {stopping && <span className="stopping-label" role="status">{t('stopping')}</span>}
        {acceptedDelivery && <ReceiptIndicator key={acceptedDelivery.id} />}

        {activeOperation ? (
          <button
            className={`send-circle stop send-sm ${stopping ? 'waiting' : ''}`}
            title={stopping ? t('stopping') : t('abort')}
            aria-label={stopping ? t('stopping') : t('abort')}
            aria-busy={stopping}
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? <span className="composer-spinner" /> : <IconStop size={16} />}
          </button>
        ) : (
          <button
            className={`send-circle send-sm ${submitPending ? 'waiting' : ''}`}
            title={submitPending ? t(pendingSlash && conv.connected ? 'commandPending' : 'connectingSession') : t('send')}
            aria-busy={submitPending}
            disabled={!canSend}
            onClick={() => void submit()}
          >
            {submitPending ? (
              <span className="composer-spinner" />
            ) : (
              <IconArrowUp size={17} />
            )}
          </button>
        )}
      </div>
      {['connecting', 'initializing', 'reconnecting', 'unresponsive', 'failed'].includes(phase) && (
        <div className={`composer-session-status${phase === 'unresponsive' || phase === 'failed' ? ' is-error' : ''}`} role="status" aria-live="polite" data-phase={phase}>
          {t(phaseTranslationKey[phase])}
          {activeOperation && !conv.connected && !conv.serviceUnresponsive && <span> {t('runStateUnknown')}</span>}
        </div>
      )}
      {attentionDeliveries.length > 0 && <div className="composer-deliveries" data-recovery-revision={recoveryRevision}>
        {attentionDeliveries.map(delivery => (
          <div key={delivery.id} className={`composer-delivery-status${delivery.state === 'failed' ? ' is-error' : ''}`} role="status" aria-live="polite" data-delivery={delivery.state}>
            <span>{attentionDeliveries.length > 1 && `${delivery.id.slice(0, 6)} · `}{t(({sending: 'deliverySending', accepted: 'deliveryAccepted', failed: 'deliveryFailed', unknown: 'deliveryUnknown'} as const)[delivery.state])}</span>
            {(delivery.state === 'unknown' || (delivery.state === 'sending' && !submitPending)) &&
              <button type="button" className="btn btn-sm" disabled={Boolean(checkingDelivery) || !conv.connected || conv.serviceUnresponsive} onClick={() => void checkDelivery(delivery.id)}>
                {t(checkingDelivery === delivery.id ? 'deliveryChecking' : 'deliveryCheck')}
              </button>}
            {unconfirmedDrafts.current.get(delivery.id)?.recoveryNeeded &&
              <button type="button" className="btn btn-sm" onClick={() => restoreUnconfirmedDraft(delivery.id, true)}>{t('restoreUnsentDraft')}</button>}
          </div>
        ))}
      </div>}
      {stopError && activeOperation && (
        <div className="composer-action-error" role="alert">
          <span>{t('stopFailed')}: {stopError}</span>
          <button className="btn btn-sm" disabled={stopping} onClick={() => void stop()}>{t('retry')}</button>
        </div>
      )}
    </div>
  );
}

/** An acknowledgement belongs beside send, not in a persistent full-width banner. */
function ReceiptIndicator() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div ref={root} className="composer-receipt" data-delivery="accepted" role="status" aria-live="polite"
      onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') setOpen(false); }}>
      <button type="button" className="composer-receipt-trigger" aria-label={t('deliveryAccepted')}
        aria-expanded={open} aria-describedby={open ? descriptionId : undefined}
        onBlur={() => setOpen(false)} onClick={() => setOpen(value => !value)}>
        <IconCheck size={14} />
        <span className="composer-receipt-label">{t('deliveryAcceptedShort')}</span>
      </button>
      {open && <div id={descriptionId} className="composer-receipt-tooltip" role="tooltip">{t('deliveryAccepted')}</div>}
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
