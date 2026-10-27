import unittest
from unittest import mock
from app.macos_window import FullscreenReveal


class Event:
    def __init__(self): self.callbacks = []
    def __iadd__(self, callback): self.callbacks.append(callback); return self
    def fire(self):
        for callback in self.callbacks: callback()


class FullscreenRevealTests(unittest.TestCase):
    def fixture(self, reduced=False):
        events = mock.Mock()
        for name in ("before_show", "loaded", "maximized", "closed"):
            setattr(events, name, Event())
        window = mock.Mock(events=events)
        appkit = mock.Mock()
        appkit.NSWorkspace.sharedWorkspace.return_value.accessibilityDisplayShouldReduceMotion.return_value = reduced
        timer = mock.Mock()
        reveal = FullscreenReveal(window, appkit, lambda fn, *args: fn(*args), mock.Mock(return_value=timer))
        return window, appkit, timer, reveal

    def test_prepare_is_invisible_and_already_screen_sized(self):
        window, _, _, _ = self.fixture()
        window.events.before_show.fire()
        window.native.setAlphaValue_.assert_called_once_with(0.0)
        window.native.setFrame_display_.assert_called_once_with(window.native.screen().frame(), False)
        window.native.makeKeyAndOrderFront_.assert_not_called()

    def test_page_load_alone_does_not_expose_half_sized_window(self):
        window, appkit, timer, _ = self.fixture()
        window.events.loaded.fire()
        window.native.makeKeyAndOrderFront_.assert_not_called()
        timer.start.assert_called_once()
        window.events.maximized.fire()
        window.native.makeKeyAndOrderFront_.assert_called_once_with(window.native)
        window.native.animator().setAlphaValue_.assert_called_once_with(1.0)
        appkit.NSAnimationContext.currentContext().setDuration_.assert_called_once_with(0.45)
        timer.cancel.assert_called_once()

    def test_fullscreen_before_page_load_still_waits_for_page(self):
        window, _, timer, _ = self.fixture()
        window.events.maximized.fire()
        window.native.makeKeyAndOrderFront_.assert_not_called()
        window.events.loaded.fire()
        window.native.makeKeyAndOrderFront_.assert_called_once()
        timer.start.assert_not_called()

    def test_timeout_cannot_strand_app_hidden(self):
        window, _, _, reveal = self.fixture()
        window.events.loaded.fire()
        reveal.reveal(True)
        window.native.makeKeyAndOrderFront_.assert_called_once()

    def test_closing_prevents_late_reveal_or_reopening(self):
        window, _, timer, reveal = self.fixture()
        window.events.loaded.fire(); window.events.closed.fire()
        window.events.maximized.fire(); reveal.reveal(True)
        window.native.makeKeyAndOrderFront_.assert_not_called()
        timer.cancel.assert_called_once()

    def test_reduced_motion_reveals_without_fade(self):
        window, appkit, _, _ = self.fixture(True)
        window.events.loaded.fire(); window.events.maximized.fire()
        window.native.setAlphaValue_.assert_called_once_with(1.0)
        appkit.NSAnimationContext.beginGrouping.assert_not_called()
