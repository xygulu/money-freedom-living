---
# 灯判定表（V0.2 B4，docs/02 §20.2）：灯的形状与文案属于书，不属于代码/i18n。
# - kind：心印身份（跨书不得重复；旧书亮过的灯不因换书熄灭）
# - topic：这盏灯落在哪条命题线上（灯属书、命题属人，docs/05 §3.2）
# - needsAction：true = 必须有真实行为记录才允许点亮（行为证据硬闸）
# - promptHint：给评估 LLM 的内部备注（中文，不面向用户）
# - label / hint：灯名与未点亮时的标准，四语（en/zh-CN/zh-TW/ja，程度句式）
# 校验：pnpm check-content（漏语言/未知命题/kind 重复都会报错到文件+字段）。
stages:
  1:
    - kind: stage1_story
      topic: parents
      needsAction: false
      promptHint: 判定的是程度不是动作：他认出今天的钱模式有来历——早期场景至今还在他身上运行（不只是「记得一件事」，而是「原来它一直在影响我」）
      label:
        en: "Seeing where your money patterns come from"
        zh-CN: "看得见来历"
        zh-TW: "看得見來歷"
        ja: "お金のパターンの「きた場所」が見えている"
      hint:
        en: "Your money patterns have a history — you can see the early scenes still running in you today; not “I remember one thing” but “so it has been shaping me all along”"
        zh-CN: "今天的钱模式在你身上有来历——你认出早期场景至今还在运行，不是「记得一件事」，而是「原来它一直在影响我」"
        zh-TW: "今天的錢模式在你身上有來歷——你認出早期場景至今還在運行，不是「記得一件事」，而是「原來它一直在影響我」"
        ja: "今のお金のパターンには「きた場所」がある——幼い頃の場面が今も自分の中で動きつづけていると認められること（「ひとつの出来事を覚えている」ではなく、「ずっと私に効いていたのか」）"
    - kind: stage1_script
      topic: self-worth
      needsAction: false
      promptHint: 他听得见那个常年在耳边说话的旧声音——知道它说什么、它怎么拦他，并且对它有了自己的态度（认下它的分量，或说出它哪里不对）
      label:
        en: "Hearing the old voice for what it is"
        zh-CN: "听得见那个声音"
        zh-TW: "聽得見那個聲音"
        ja: "頭の中の古い声が聞こえている"
      hint:
        en: "The old voice that has talked in your ear for years — you can hear it, know how it stops you, and hold your own stance toward it: own its weight, or name what it gets wrong"
        zh-CN: "那个常年在你耳边说话的旧声音，你听得见它、知道它怎么拦你，并且对它有了自己的态度——认下它的分量，或说出它哪里不对"
        zh-TW: "那個常年在你耳邊說話的舊聲音，你聽得見它、知道它怎麼攔你，並且對它有了自己的態度——認下它的分量，或說出它哪裡不對"
        ja: "長年耳もとで話しつづけてきた古い声——それが何を言い、どう立ち止まらせるかが聞こえ、その声への自分の態度を持てていること（その重みを引き取るか、どこが違うかを言葉にする）"
    - kind: stage1_color
      topic: inner-turmoil
      needsAction: false
      promptHint: 他认得自己面对钱时反复泛起的底色感受（怕/愧/不配……），并能承认「这是我的底色」——只是看见，不评判
      label:
        en: "Recognizing your money undertone"
        zh-CN: "认得出自己的底色"
        zh-TW: "認得出自己的底色"
        ja: "自分の底の色を認めている"
      hint:
        en: "The undertone that keeps surfacing when money appears (fear, guilt, unworthiness…) — you can recognize it and own it as yours. Just seeing, no judging"
        zh-CN: "面对钱时反复泛起的底色感受（怕、愧、不配……），你能认出并承认「这是我的」——只是看见，不评判"
        zh-TW: "面對錢時反覆泛起的底色感受（怕、愧、不配……），你能認出並承認「這是我的」——只是看見，不評判"
        ja: "お金の前で繰り返し浮かびあがる自分の底の色（怖さ・罪悪感・自分はふさわしくない……）を認め、「これは私のものだ」と言えること——ただ見るだけで、裁かない"
  2:
    - kind: stage2_claim
      topic: self-worth
      needsAction: false
      promptHint: 旧脚本从「天经地义的事实」变成「他自己的东西」——他亲口认领它（它当年保护过他），或明确说它已经不再是我；认领的那一刻，松动就开始了
      label:
        en: "The old script, claimed as yours"
        zh-CN: "旧脚本被你认领"
        zh-TW: "舊腳本被你認領"
        ja: "古いスクリプトを引き取っている"
      hint:
        en: "It turns from “an obvious fact” into “something of mine” — you claim it out loud (it once protected you), or say clearly it is no longer you. The moment you claim it, the loosening begins"
        zh-CN: "它从「天经地义的事实」变成「我自己的东西」——你亲口认领它（它当年保护过你），或明确说它已经不再是我。认领的那一刻，松动就开始了"
        zh-TW: "它從「天經地義的事實」變成「我自己的東西」——你親口認領它（它當年保護過你），或明確說它已經不再是我。認領的那一刻，鬆動就開始了"
        ja: "それが「あたりまえの事実」から「自分のもの」になる——古いスクリプトを自分のものだと口にするか（あの頃は自分を守ってくれた）、もう自分ではないとはっきり言えること。引き取ったその瞬間から、ゆるみがはじまる"
    - kind: stage2_try
      topic: allowing
      needsAction: true
      promptHint: 允许真的在他身上发生过——为自己破过一次例、放自己一马，或改写过一句内在台词，体感松了一点（心虚、做砸都算，那说明碰到了旧脚本）；做过什么是证据，「允许了自己」才是标准
      label:
        en: "Having truly allowed yourself"
        zh-CN: "允许过自己"
        zh-TW: "允許過自己"
        ja: "自分を許せている"
      hint:
        en: "Permission has really happened in you: you broke one small rule for yourself, gave yourself a break, or rewrote a line in your head — and felt it loosen (guilt or fumbling counts; it means you touched the old script). The act is only evidence; the allowance itself is the bar"
        zh-CN: "允许真的在你身上发生过：为自己破过一次例、放自己一马，或改写一句内在台词，体感松了一点——心虚、做砸都算，那说明碰到了旧脚本。破例只是证据，「允许了自己」才是标准"
        zh-TW: "允許真的在你身上發生過：為自己破過一次例、放自己一馬，或改寫一句內在台詞，體感鬆了一點——心虛、做砸都算，那說明碰到了舊腳本。破例只是證據，「允許了自己」才是標準"
        ja: "許しが本当に起きたこと——自分のために小さな掟をひとつ破る、自分を解放する、心の中のせりふをひとつ書き替える。少しゆるんだ体感があればいい（後ろめたさや失敗も、古いスクリプトに触れた証拠）。破ったこと自体は証拠で、「自分を許した」ことが基準"
    - kind: stage2_voice
      topic: boundaries
      needsAction: false
      promptHint: 他的话语里看得见松动——「我可以选择」「我想试试」开始替代「必须/应该/不敢」；话语是内心松紧的体温计
      label:
        en: "“I can choose” replacing “must”"
        zh-CN: "话语里有了「可以选」"
        zh-TW: "話語裡有了「可以選」"
        ja: "ことばに「選べる」が現れている"
      hint:
        en: "Your words show the loosening — “I can choose” and “I want to try” starting to replace “must / should / dare not”. Words are the gauge of how tight or loose it is inside"
        zh-CN: "话语里看得见松动——「我可以选择」「我想试试」开始替代「必须、应该、不敢」；话语是内心松紧的体温计"
        zh-TW: "話語裡看得見鬆動——「我可以選擇」「我想試試」開始替代「必須、應該、不敢」；話語是內心鬆緊的體溫計"
        ja: "ことばにゆるみが見える——「選べる」「試してみたい」が「〜しなきゃ／すべき／無理」に代わって現れる。ことばは内面のゆるみの体温計"
  3:
    - kind: stage3_seven
      topic: money-safety
      needsAction: true
      promptHint: 新做法在他的日子里稳定下来——与钱打交道时自然用它，不再靠硬撑和提醒；做过几轮只是证据，稳定成日常才是标准
      label:
        en: "The new way woven into your ordinary days"
        zh-CN: "新方式成了日常"
        zh-TW: "新方式成了日常"
        ja: "新しいやり方が日常になっている"
      hint:
        en: "The new way has settled into your days — you use it naturally with money, without white-knuckling or reminders. Rounds done are only evidence; becoming ordinary is the bar"
        zh-CN: "新做法在你的日子里稳定下来——与钱打交道时自然用它，不再靠硬撑和提醒。做过几轮只是证据，稳定成日常才是标准"
        zh-TW: "新做法在你的日子裡穩定下來——與錢打交道時自然用它，不再靠硬撐和提醒。做過幾輪只是證據，穩定成日常才是標準"
        ja: "新しいやり方が自分の日々に安定していること——お金と接するとき、無理に支えたり思い出したりしなくても自然に使えている。何周やったかは証拠で、日常になったことが基準"
    - kind: stage3_review
      topic: inner-turmoil
      needsAction: true
      promptHint: 他能自己看见变化——不用别人告诉他，他自己说得出「哪里不一样了」；有变化、没变化、说不清都算，只要是自己的观察
      label:
        en: "Seeing the change for yourself"
        zh-CN: "自己看得见变化"
        zh-TW: "自己看得見變化"
        ja: "変化を自分で見えている"
      hint:
        en: "You can see the change yourself — without being told, you can say “what's different now”. Changed, unchanged, or can't tell — all count, as long as it is your own observation"
        zh-CN: "你能自己看见变化——不用别人告诉你，你自己说得出「哪里不一样了」。有变化、没变化、说不清都算，只要是自己的观察"
        zh-TW: "你能自己看見變化——不用別人告訴你，你自己說得出「哪裡不一樣了」。有變化、沒變化、說不清都算，只要是自己的觀察"
        ja: "変化を自分で見えていること——人に言われなくても「どこが違うか」を自分のことばで言える。変わった／変わらない／わからない、どれも自分の観察なら"
---

第一本书的灯图：三个可达阶段，每段 2–3 盏。判定表原在 `src/lib/stage.ts`
（MONEY_FREEDOM_LAMPS），2026-09-20 随 V0.2 B4 搬进内容层——换书 = 换这张表，
不改代码；灯的展示文案（label/hint 四语）随之离开 i18n（U6：书的语汇不得留在产品层）。
阶段 4「活法」没有灯，也没有终点线。
