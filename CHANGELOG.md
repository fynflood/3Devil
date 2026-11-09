# Changelog

Each version's section becomes its release notes and what 3Devil shows after updating. Write for the people using the app, and add a section before tagging a release.

## 0.1.9

- **Filament left to print:** each project shows roughly how much filament it still needs next to the time left, and each part has a *Filament per copy* you can type in. Tracked prints record it from the slicer's figures: read from the print file on Bambu printers, and from the file's details on Klipper and Prusa.
- **Filled in from your Bambu printer:** parts with no weight yet get one from the sliced files the printer still keeps, so prints from before this update count too.
- **Project stats:** hover over a project's progress to see prints that worked and failed, printer time and filament used (including on failed prints), how much you print a day, what's left, and roughly when you'll finish.
- **Tidier project header:** time and filament left share one line, the progress lines up with the part panel, and an empty description no longer shows "Description".

## 0.1.8

- **Elegoo printers** such as the Saturn 4, Mars 5 and Centauri Carbon: find them with Scan, see the current print, time left and temperatures, including the resin vat and UV light, and watch the camera. Parts for an Elegoo resin printer open in CHITUBOX or Lychee Slicer when one is turned on.
- **Fixed running out of memory:** when another app started watching a Bambu printer's camera, 3Devil could use all the computer's memory until it was forced to close.
- **Cameras only run while you're looking:** they stop when you leave the Printers page or minimize the window, and start again when you come back.

## 0.1.7

- **Model Library** replaces the DriveThruRPG library, and sources are chosen and connected on that screen.
- **MyMiniFactory:** sign in to see your likes and collections, marked where you own a model, paste a link to add any model, and download what you own into a project.
- **Printers page** with live camera, current print, time left, temperatures, fans and filament.
- **Klipper printers** connect through Moonraker.
- **New slicers:** OrcaSlicer, Lychee Slicer and CHITUBOX, each of which can be turned on or off under Settings.
- **Default print presets:** choose one of your saved presets for Bambu Studio or PrusaSlicer under Settings, and new windows open with it.
- **Printing badge and live progress** on the part being printed. The rest of its job stays queued.
- **Remove folders** from a project, with the choice of moving them to the Trash.
- **Plates of several objects** are now tracked like single prints.
- **Tidier project view:** folders line up in columns and animate open and shut, the filters stay in view, the side panel slides, and buttons have tooltips.
- **Updates ask first:** an update found when 3Devil starts asks whether to install it now, and tells you what's in it.
