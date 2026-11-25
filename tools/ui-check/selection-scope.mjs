import assert from 'node:assert/strict'

export async function checkTableSelection(browser, origin) {
  const context = await browser.newContext({viewport:{width:1280,height:800}})
  const cells = {A1:'apple', B1:'apple', A2:'apple', B2:'apple', C2:'apple'}
  try {
    await context.addInitScript(({cells}) => {
      if (localStorage.getItem('videron.library.v1')) return
      const sheet = {id:'sheet',type:'table',x:0,y:0,w:480,h:205,rows:3,cols:3,name:'Tasks',cells}
      const shape = {id:'label',type:'rect',x:560,y:0,w:100,h:85,label:'apple',locked:true}
      const notes = ['Canvas','Inline drawing','Inline table'].map((title, i) => {
        const board = {version:1,elements:i===2 ? [sheet] : [sheet,shape]}
        return {id:'scope-'+i,title,x:i*150,y:0,tags:[],links:[],plain:'',
          ...(i===0 ? {type:'canvas',board,body:[]} : {body:[{type:'drawing',board}]})}
      })
      localStorage.setItem('videron.interface-language.v1','en')
      localStorage.setItem('videron.library.v1',JSON.stringify({version:1,active:'personal',
        spaces:{personal:{notes,areas:[]}},plugins:[],view:{manualLayout:true}}))
    }, {cells})
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    await page.goto(origin)
    const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform))
    const shortcut = mac ? 'Meta' : 'Control'
    const cell = address => page.locator('[data-vt-addr="'+address+'"]')
    const visibleValues = () => page.locator('[data-vt-addr]').evaluateAll(nodes =>
      Object.fromEntries(nodes.filter(node=>node.textContent).map(node=>[node.dataset.vtAddr,node.textContent])))
    for (const title of ['Canvas','Inline drawing','Inline table']) {
      await page.locator('.tree-note-link').filter({hasText:title}).click()
      await cell('A1').click()
      await page.keyboard.press('Shift+ArrowDown')
      await page.locator('.vt-address').filter({hasText:'A1:A2'}).waitFor({state:'attached'})
      await page.keyboard.press(mac ? 'Alt+Meta+f' : 'Control+h')
      const panel = page.getByRole('search',{name:'Find in note'})
      await panel.getByRole('textbox',{name:'Find',exact:true}).fill('apple')
      await panel.getByRole('textbox',{name:'Replace with'}).fill('orange')
      await panel.getByRole('button',{name:'Find in selection'}).click()
      assert.equal(await panel.locator('output').textContent(),'1 / 2',title)
      await panel.locator('[data-find-action=replaceAll]').click()
      await page.keyboard.press('Escape')
      assert.deepEqual(await visibleValues(),{...cells,A1:'orange',A2:'orange'},title)
      await page.keyboard.press(shortcut+'+z')
      assert.deepEqual(await visibleValues(),cells,title+' undo')
      await page.locator('.vd-editor .ve-head > button').first().click()
      await page.locator('.vd-editor').waitFor({state:'hidden'})
    }
  } finally {
    await context.close()
  }
}
