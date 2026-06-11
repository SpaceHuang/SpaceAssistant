import { useEffect, useMemo, useRef } from 'react'
import { Button, Input, Tooltip, Typography } from 'antd'
import { X } from 'lucide-react'
import { useSearch } from './SearchProvider'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './searchBar.css'

export function SearchBar() {
  const { t } = useTypedTranslation('search')
  const {
    isOpen,
    query,
    options,
    panelSupported,
    matchIndex,
    totalMatches,
    matchOverflow,
    isUpdating,
    regexError,
    wholeWordDisabled,
    focusToken,
    close,
    setQuery,
    toggleOption,
    goNext,
    goPrev
  } = useSearch()
  const inputRef = useRef<HTMLInputElement>(null)
  const disabled = !panelSupported
  const navDisabled = disabled || totalMatches === 0 || Boolean(regexError)

  useEffect(() => {
    if (!isOpen || focusToken === 0) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [focusToken, isOpen])

  const countLabel = useMemo(() => {
    if (disabled) return '—'
    if (regexError) return t('searchBar.matchCount', { current: 0, total: 0 })
    if (totalMatches === 0) return t('searchBar.matchCount', { current: 0, total: 0 })
    const current = matchIndex >= 0 ? matchIndex + 1 : 0
    const total = matchOverflow ? `${totalMatches}+` : String(totalMatches)
    if (isUpdating) {
      return t('searchBar.matchCountUpdating', { current, total })
    }
    if (matchOverflow) {
      return t('searchBar.matchCountOverflow', { current, total: totalMatches })
    }
    return t('searchBar.matchCount', { current, total })
  }, [disabled, regexError, totalMatches, matchIndex, matchOverflow, isUpdating, t])

  const navAnnouncement = useMemo(() => {
    if (disabled || regexError || totalMatches === 0 || matchIndex < 0) return ''
    return t('searchBar.navAnnouncement', {
      current: matchIndex + 1,
      total: matchOverflow ? `${totalMatches}+` : totalMatches
    })
  }, [disabled, regexError, totalMatches, matchIndex, matchOverflow, t])

  if (!isOpen) return null

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      goNext()
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      goPrev()
    }
  }

  return (
    <div
      className={`search-bar${disabled ? ' search-bar--disabled' : ''}`}
      role="search"
      aria-label={t('searchBar.ariaLabel')}
    >
      <div className="search-bar__row">
        <Input
          ref={inputRef}
          size="small"
          className="search-bar__input"
          placeholder={t('detail.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          status={regexError ? 'error' : undefined}
          disabled={disabled}
          aria-label={t('detail.placeholder')}
        />
        <div className="search-bar__options">
          <button
            type="button"
            className={`search-bar__opt${options.caseSensitive ? ' search-bar__opt--active' : ''}`}
            title={t('detail.caseSensitiveTitle')}
            aria-label={t('detail.caseSensitiveTitle')}
            disabled={disabled}
            onClick={() => toggleOption('caseSensitive')}
          >
            Aa
          </button>
          <Tooltip title={wholeWordDisabled ? t('searchBar.wholeWordCjkHint') : t('detail.wholeWordTitle')}>
            <button
              type="button"
              className={`search-bar__opt${options.wholeWord ? ' search-bar__opt--active' : ''}`}
              title={t('detail.wholeWordTitle')}
              aria-label={t('detail.wholeWordTitle')}
              disabled={disabled || wholeWordDisabled}
              onClick={() => toggleOption('wholeWord')}
            >
              W
            </button>
          </Tooltip>
          <button
            type="button"
            className={`search-bar__opt${options.useRegex ? ' search-bar__opt--active' : ''}`}
            title={t('detail.regexTitle')}
            aria-label={t('detail.regexTitle')}
            disabled={disabled}
            onClick={() => toggleOption('useRegex')}
          >
            .*
          </button>
        </div>
        <Button size="small" type="text" onClick={goPrev} disabled={navDisabled} aria-label={t('searchBar.prevTitle')}>
          ↑
        </Button>
        <Button size="small" type="text" onClick={goNext} disabled={navDisabled} aria-label={t('searchBar.nextTitle')}>
          ↓
        </Button>
        <Typography.Text type="secondary" className="search-bar__count" aria-live="polite">
          {countLabel}
        </Typography.Text>
        <span className="search-bar__sr-only" aria-live="polite">
          {navAnnouncement}
        </span>
        <button
          type="button"
          className="search-bar__close"
          title={t('detail.closeTitle')}
          aria-label={t('detail.closeTitle')}
          onClick={close}
        >
          <X size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {regexError ? (
        <Typography.Text type="danger" className="search-bar__error">
          {regexError}
        </Typography.Text>
      ) : null}
      {disabled ? (
        <Typography.Text type="secondary" className="search-bar__hint">
          {t('searchBar.unsupportedPanel')}
        </Typography.Text>
      ) : null}
    </div>
  )
}
