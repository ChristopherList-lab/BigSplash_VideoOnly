#!/bin/zsh
# Save an API key to a private file in your home folder without showing it on screen.
# Usage: zsh save-key.sh google | anthropic | meta
case "$1" in
  google|anthropic|meta) ;;
  *) echo "Usage: zsh save-key.sh google | anthropic | meta"; exit 1 ;;
esac
file="$HOME/.bigsplash-$1-key"
read -s "key?Paste your $1 key, then press Enter (nothing shows as you paste): "
echo
if [[ -z "$key" ]]; then echo "Nothing was pasted. Run it again."; exit 1; fi
print -r -- "$key" > "$file" && chmod 600 "$file" && echo "Saved to $file"
