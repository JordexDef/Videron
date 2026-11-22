import {tr} from './i18n.js'

// Cover the last rendered frame before waiting on an editor, a disk write,
// or the key store. The caller removes the cover only at a safe destination.
export function showLockScreen() {
  const screen = document.createElement('dialog')
  screen.className = 'vault-lock-screen'
  const panel = document.createElement('div')
  const heading = document.createElement('h1'), message = document.createElement('p')
  heading.id = 'vault-lock-heading'
  heading.textContent = tr('Блокировка', 'Locking')
  message.textContent = tr('Сохраняем изменения…', 'Saving changes…')
  message.setAttribute('role','status')
  screen.setAttribute('aria-labelledby',heading.id)
  screen.addEventListener('cancel',event=>event.preventDefault())
  panel.append(heading,message)
  screen.append(panel)
  document.body.append(screen)
  screen.showModal()

  let retryButton
  return {
    failed(onRetry) {
      heading.textContent = tr('Не удалось завершить блокировку', 'Could not finish locking')
      message.textContent = tr('Изменения остаются в памяти. Проверьте доступ к хранилищу и повторите сохранение.',
        'Your changes are still in memory. Check access to storage and try saving again.')
      if (!retryButton) {
        retryButton = document.createElement('button')
        retryButton.type = 'button'
        retryButton.className = 'button primary'
        retryButton.textContent = tr('Повторить сохранение', 'Retry saving')
        panel.append(retryButton)
      }
      retryButton.disabled = false
      retryButton.onclick = () => {
        retryButton.disabled = true
        heading.textContent = tr('Блокировка', 'Locking')
        message.textContent = tr('Сохраняем изменения…', 'Saving changes…')
        onRetry()
      }
      retryButton.focus()
    },
    close() {
      screen.close()
      screen.remove()
    }
  }
}
