// input: @nestjs/common, ../../common/jwt.guard, ./deepseek.service
// output: StoryController, route:story
// pos: 后端/学习模块
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../../common/jwt.guard'
import { safeError } from '../../common/redact'
import { DeepSeekService } from './deepseek.service'

@Controller('story')
export class StoryController {
    constructor(
        private deepseek: DeepSeekService
    ) { }

    @Post('generate')
    @UseGuards(JwtGuard)
    async generate(@Body() body: { words: string[] }) {
        if (!body.words || body.words.length === 0) {
            return { story: 'Please select some words first!' }
        }

        const safeList = body.words.filter(w => typeof w === 'string' && w.trim().length > 0)
        if (safeList.length === 0) return { story: 'No valid words found.' }

        try {
            const result = await this.deepseek.generateStory(safeList)
            return result // result is already { story, translation }
        } catch (e) {
            console.error('Story Generation Error:', safeError(e))
            throw e
        }
    }
}
