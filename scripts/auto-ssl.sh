#!/bin/bash
DOMAIN="assistant.iam-ab.com"
EXPECTED_IP="13.201.33.5"
LOG_FILE="/home/ubuntu/auto-ssl.log"

# Query public DNS resolver (Google 8.8.8.8) to check actual propagation
RESOLVED_IP=$(dig +short @8.8.8.8 "$DOMAIN" | tail -n1)

if [ "$RESOLVED_IP" = "$EXPECTED_IP" ]; then
    echo "[$(date)] DNS propagated! $DOMAIN resolves to $EXPECTED_IP. Requesting Let's Encrypt SSL certificate..." >> "$LOG_FILE"
    sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >> "$LOG_FILE" 2>&1
    if [ $? -eq 0 ]; then
        echo "[$(date)] SSL successfully configured and active for https://$DOMAIN!" >> "$LOG_FILE"
        # Remove cron job once SSL is successfully configured
        (crontab -l 2>/dev/null | grep -v 'auto-ssl.sh') | crontab -
    else
        echo "[$(date)] Certbot encountered an issue. Will retry next cycle." >> "$LOG_FILE"
    fi
else
    echo "[$(date)] Waiting for DNS: $DOMAIN resolves to '$RESOLVED_IP' (expected $EXPECTED_IP)" >> "$LOG_FILE"
fi
