if exists('g:loaded_ddu_tgrep')
  finish
endif
let g:loaded_ddu_tgrep = 1

command! -nargs=? -complete=dir DduTgrepStop call ddu_tgrep#stop(<q-args>)
