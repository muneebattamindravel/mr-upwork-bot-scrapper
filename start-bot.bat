@echo off
cd /d "C:\Users\Administrator\Desktop\mr-upwork-bot-scrapper"
start "" cmd /k "set BOT_AGENT_LAUNCHED=1 && npm start -- --bot-agent=ec2-micro-1"
