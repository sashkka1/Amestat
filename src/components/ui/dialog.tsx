"use client"

import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

// 🔴 Все окна сайта — НЕмодальный Dialog радикса (владелец, 2026-09-29: выделенный текст
// должен переводиться везде, а в окнах значок переводчика у выделения не работал).
// Модальный Dialog, пока открыт, вешает `aria-hidden` на всю остальную страницу,
// `pointer-events: none` на body, запирает фокус и закрывается от нажатия на любой чужой
// элемент — в том числе на значок переводчика. Что нужно от модального, сделано здесь же:
// затемнение (нажатие на него закрывает), запрет прокрутки страницы под окном. Escape,
// порядок слоёв и возврат фокуса радикс держит и без модальности.
function Dialog({
  modal = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" modal={modal} {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

// Затемнение — свой div: `DialogPrimitive.Overlay` у немодального окна не рисуется вовсе.
function DialogOverlay({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-overlay"
      aria-hidden="true"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// Страница под окном не прокручивается, как было при модальном Dialog; место полосы
// прокрутки держим отступом, иначе страница под затемнением прыгнет вбок. Счётчик — на
// случай двух окон разом (попап креатора на Payments и окно выплаты поверх него).
let scrollLocks = 0
let scrollSaved = { overflow: "", paddingRight: "" }

function ScrollLock() {
  React.useEffect(() => {
    const body = document.body
    if (scrollLocks++ === 0) {
      const gap = window.innerWidth - document.documentElement.clientWidth
      scrollSaved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight }
      body.style.overflow = "hidden"
      if (gap > 0) body.style.paddingRight = `${gap}px`
    }
    return () => {
      if (--scrollLocks === 0) {
        body.style.overflow = scrollSaved.overflow
        body.style.paddingRight = scrollSaved.paddingRight
      }
    }
  }, [])
  return null
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onPointerDownOutside,
  onFocusOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const overlay = React.useRef<HTMLDivElement>(null)
  return (
    <DialogPortal>
      <DialogOverlay ref={overlay} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
        /* Без `tabIndex`, который радикс ставит окну: иначе щелчок по тексту отдаёт фокус
           самому окну, а не странице, как везде на сайте. */
        tabIndex={undefined}
        /* Закрывает окно только нажатие на его затемнение. Чужие элементы поверх
           страницы (значок переводчика, тосты, окно выплаты над попапом) — не повод. */
        onPointerDownOutside={(e) => {
          onPointerDownOutside?.(e)
          if (e.target !== overlay.current) e.preventDefault()
        }}
        onFocusOutside={(e) => {
          onFocusOutside?.(e)
          e.preventDefault()
        }}
      >
        <ScrollLock />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
