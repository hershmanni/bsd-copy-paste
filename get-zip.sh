#!/bin/zsh

# -x excludes 
zip -r "../bsd-copy-paste-${1}.zip" * -x get-zip.sh .git/* dev-store/* dev-store/ .git/ helpers/*