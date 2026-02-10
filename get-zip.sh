#!/bin/zsh

# -x excludes (quoted to avoid zsh "no matches found" glob errors)
zip -r "../bsd-copy-paste-${1}.zip" . \
  -x "get-zip.sh" ".git/*" ".git/" "dev-store/*" "dev-store/" "helpers/*" ".hidden/*" ".hidden/" "*.DS_Store"
