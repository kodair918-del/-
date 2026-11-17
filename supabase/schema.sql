-- スピン・アリーナ：ゴースト保存用のテーブル（Supabase の SQL Editor に貼って Run するだけ）
create extension if not exists pgcrypto;

create table if not exists public.ghosts (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  nick        text not null check (char_length(nick) <= 12),
  title       text not null default '' check (char_length(title) <= 20),
  design      jsonb not null check (pg_column_size(design) < 1000),
  rpm         integer not null check (rpm between 300 and 50000),
  arena       text not null default 'normal' check (char_length(arena) <= 12),
  inputs      jsonb not null check (jsonb_typeof(inputs) = 'array' and pg_column_size(inputs) < 12000),
  res         jsonb check (pg_column_size(res) < 500),
  wins        integer not null default 0,   -- このゴーストが挑戦者に勝った回数
  losses      integer not null default 0    -- 挑戦者に負けた回数
);
create index if not exists ghosts_rpm_idx on public.ghosts (rpm);
create index if not exists ghosts_wins_idx on public.ghosts (wins desc, created_at desc);

alter table public.ghosts enable row level security;

-- 誰でも読める。誰でも「新しいゴースト」は追加できるが、勝敗の数字を自分で書いて作ることはできない。更新・削除は不可。
drop policy if exists "ghosts_read" on public.ghosts;
create policy "ghosts_read" on public.ghosts for select using (true);
drop policy if exists "ghosts_insert" on public.ghosts;
create policy "ghosts_insert" on public.ghosts for insert with check (wins = 0 and losses = 0);

-- 勝敗の報告：ゴーストの wins / losses を1だけ増やす専用の関数。ゴーストが3回負けたら、サーバーから消える
create or replace function public.report_result(gid uuid, won boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.ghosts set wins = wins + (case when won then 1 else 0 end), losses = losses + (case when won then 0 else 1 end) where id = gid;
  delete from public.ghosts where id = gid and losses >= 3;
end;
$$;
revoke all on function public.report_result(uuid, boolean) from public;
grant execute on function public.report_result(uuid, boolean) to anon;

-- すでに3回以上負けているゴーストを、いま消しておく（1回だけでOK）
delete from public.ghosts where losses >= 3;

-- （おすすめ）古いゴーストを消したいとき：30日より前のもの。必要なら SQL Editor で時々実行するか、Supabase の Scheduled Jobs に登録
-- delete from public.ghosts where created_at < now() - interval '30 days' and wins < 3;

-- ====================================================================
-- ランキング（連勝戦・ハード・ビッグ優勝・ゴースト勝利・デイリーチャレンジ）
-- ====================================================================
create table if not exists public.scores (
  board      text not null check (board ~ '^(stage|hard|bigwins|ghostwins|daily-[0-9]{4}-[0-9]{2}-[0-9]{2})$'),
  uid        text not null check (char_length(uid) between 8 and 40),   -- 端末ごとのランダムID（みんなには見せない）
  nick       text not null check (char_length(nick) <= 12),
  score      integer not null check (score between 0 and 100000),
  meta       jsonb check (pg_column_size(meta) < 400),
  updated_at timestamptz not null default now(),
  primary key (board, uid)
);
alter table public.scores enable row level security;
drop policy if exists "scores_read" on public.scores;
create policy "scores_read" on public.scores for select using (true);
-- uid は読めないようにする（読めると、他人になりすまして書き換えられてしまうため）
revoke all on public.scores from anon;
grant select (board, nick, score, meta, updated_at) on public.scores to anon;

-- スコアの送信（その人のその種目のベスト記録だけを残す）。直接の書き込みはできず、この関数だけ
create or replace function public.submit_score(p_board text, p_uid text, p_nick text, p_score integer, p_meta jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare maxs integer;
begin
  maxs := case when p_board in ('stage', 'hard') then 31 when p_board = 'bigwins' then 5000 when p_board = 'ghostwins' then 100000 else 5000 end;
  if p_score < 0 or p_score > maxs then raise exception 'bad score'; end if;
  insert into public.scores (board, uid, nick, score, meta) values (p_board, p_uid, left(p_nick, 12), p_score, p_meta)
  on conflict (board, uid) do update set
    score = greatest(public.scores.score, excluded.score), nick = excluded.nick,
    meta = case when excluded.score >= public.scores.score then excluded.meta else public.scores.meta end,
    updated_at = case when excluded.score > public.scores.score then now() else public.scores.updated_at end;
end;
$$;
revoke all on function public.submit_score(text, text, text, integer, jsonb) from public;
grant execute on function public.submit_score(text, text, text, integer, jsonb) to anon;
