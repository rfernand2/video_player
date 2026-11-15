@echo off
rem Starts the player without keeping a console window open.
rem Drop a video file onto this script to open it.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
