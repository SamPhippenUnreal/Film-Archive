"""Reveal the Mac window only after page load and native fullscreen placement."""
import logging
import threading

log = logging.getLogger("archive.macos")


class FullscreenReveal:
    def __init__(self, window, appkit, dispatch, timer_factory=threading.Timer):
        self.window, self.appkit, self.dispatch = window, appkit, dispatch
        self.timer_factory = timer_factory
        self.loaded = self.fullscreen = self.revealed = self.closed = False
        self.timer = None
        window.events.before_show += self.prepare
        window.events.loaded += self.page_loaded
        window.events.maximized += self.entered_fullscreen
        window.events.closed += self.close

    def prepare(self):
        # before_show runs on Cocoa's main thread, before fullscreen is requested.
        native = self.window.native
        native.setAlphaValue_(0.0)
        screen = native.screen()
        if screen is not None:
            native.setFrame_display_(screen.frame(), False)

    def page_loaded(self):
        if self.revealed or self.closed:
            return
        self.loaded = True
        # Never strand the app hidden if a native fullscreen notification is lost.
        self.timer = self.timer_factory(2.5, lambda: self.dispatch(self.reveal, True))
        self.timer.daemon = True
        self.dispatch(self.reveal)
        if not self.revealed:
            self.timer.start()

    def entered_fullscreen(self):
        self.fullscreen = True
        self.dispatch(self.reveal)

    def reveal(self, fallback=False):
        if self.closed or self.revealed or not self.loaded or not (self.fullscreen or fallback):
            return
        self.revealed = True
        if self.timer:
            self.timer.cancel()
        native = self.window.native
        native.makeKeyAndOrderFront_(native)
        reduced = self.appkit.NSWorkspace.sharedWorkspace().accessibilityDisplayShouldReduceMotion()
        if reduced:
            native.setAlphaValue_(1.0)
            return
        self.appkit.NSAnimationContext.beginGrouping()
        try:
            self.appkit.NSAnimationContext.currentContext().setDuration_(0.45)
            native.animator().setAlphaValue_(1.0)
        finally:
            self.appkit.NSAnimationContext.endGrouping()

    def close(self):
        self.closed = True
        if self.timer:
            self.timer.cancel()


def configure(window):
    import AppKit
    from PyObjCTools import AppHelper
    return FullscreenReveal(window, AppKit, AppHelper.callAfter)
