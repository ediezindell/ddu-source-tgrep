function! ddu_tgrep#stop(path) abort
  echomsg denops#request('ddu-tgrep', 'stop', [a:path])
endfunction
